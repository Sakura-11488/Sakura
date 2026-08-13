import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import AvatarApologyModal from '@/components/AvatarApologyModal';
import AvatarMintPickerModal from '@/components/social/AvatarMintPickerModal';
import {
  acknowledgeAvatarApologyGrant,
  buildAvatarAuthHeaders,
  fetchAvatarApologyGrantDetail,
  fetchAvatarApologyGrantStatus,
  selectAvatarMint,
  type AvatarApologyGrantStatus,
  type AvatarMintItem,
} from '@/lib/user-avatar';

/** Long enough for AnimatedSplash to finish; a Modal paints above it regardless
 *  of sibling order, and opening on top of the splash is a bad first frame. */
const FIRST_CHECK_DELAY_MS = 1800;

/**
 * Shows the one-time apology to a wallet that was charged SAKURA and received
 * nothing, and lets them pick one of the comped avatars as their profile picture.
 *
 * Wallet-keyed rather than session-keyed (the CloudSyncBridge pattern, not the
 * AppUpdateBridge one): the durable "already decided" latch lives in Postgres, so
 * it survives reinstalls and follows the user between the APK and the web PWA.
 * The in-memory ref here only saves repeat requests within one process.
 *
 * `restoring` matters: `connected === false` cannot distinguish "no wallet" from
 * "haven't looked yet" on a cold start.
 */
export default function AvatarApologyBridge() {
  const { address, connected, restoring, unlockForAppSession } = useWallet();

  const [grant, setGrant] = useState<AvatarApologyGrantStatus | null>(null);
  const [avatars, setAvatars] = useState<AvatarMintItem[]>([]);
  const [stage, setStage] = useState<'card' | 'picker'>('card');
  const [busy, setBusy] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);

  // Wallet this process has already asked about (or hidden for this session).
  const settledRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const busyRef = useRef(false);

  const settleLocally = useCallback((wallet: string | null) => {
    settledRef.current = wallet;
    setGrant(null);
    setAvatars([]);
    setStage('card');
    setSelectingId(null);
    setBusy(false);
    busyRef.current = false;
  }, []);

  const check = useCallback(async (wallet: string) => {
    if (inFlightRef.current || settledRef.current === wallet) return;
    inFlightRef.current = true;
    try {
      const status = await fetchAvatarApologyGrantStatus(wallet);
      // A null result is a network/edge failure, not "no grant". Leave the wallet
      // unsettled so the next resume tries again.
      if (!status) return;
      if (!status.has_grant || status.resolved) {
        settledRef.current = wallet;
        return;
      }
      // Grant recorded but not every promised avatar has landed. Stay quiet and
      // ask again next launch rather than claiming four and showing two.
      if (!status.ready) return;
      setGrant(status);
      setStage('card');
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (restoring || !connected || !address) {
      if (!connected || !address) settledRef.current = null;
      return;
    }

    const wallet = address;
    let cancelled = false;

    const timer = setTimeout(() => {
      if (!cancelled) check(wallet);
    }, FIRST_CHECK_DELAY_MS);

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !cancelled) check(wallet);
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      sub.remove();
    };
  }, [restoring, connected, address, check]);

  /** Session-only escape. Never touches the wallet, so it can never fail. */
  const handleLater = useCallback(() => {
    if (busyRef.current) return;
    settleLocally(address ?? null);
  }, [address, settleLocally]);

  const handlePick = useCallback(async () => {
    if (busyRef.current || !address) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair) {
        // Do NOT trap the user behind a credential operation that can fail.
        showAlert(
          'Approval needed',
          'We could not confirm it was you, so nothing changed. Your avatars are safe in your wallet — we will show this again next time you open Sakura.',
        );
        settleLocally(address);
        return;
      }
      // This call is what marks the apology as SHOWN server-side, and it returns
      // resolved:true if another device already handled it.
      const detail = await fetchAvatarApologyGrantDetail(buildAvatarAuthHeaders(keypair));
      if (detail.resolved || !detail.ready || detail.avatars.length === 0) {
        settleLocally(address);
        return;
      }
      setAvatars(detail.avatars);
      setStage('picker');
    } catch (error) {
      showAlert(
        'Could not load your avatars',
        error instanceof Error ? error.message : 'Try again in a moment.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [address, settleLocally, unlockForAppSession]);

  const handleSelect = useCallback(
    async (mint: AvatarMintItem) => {
      if (busyRef.current || !address) return;
      busyRef.current = true;
      setBusy(true);
      setSelectingId(mint.id);
      try {
        const keypair = await unlockForAppSession();
        if (!keypair) {
          showAlert(
            'Approval needed',
            'We could not confirm it was you, so nothing changed. We will show this again next time you open Sakura.',
          );
          settleLocally(address);
          return;
        }
        const headers = buildAvatarAuthHeaders(keypair);

        // The select IS the resolution — the server latches the grant on a
        // successful pick. So once this resolves, the operation succeeded no
        // matter what happens to the acknowledgement below.
        await selectAvatarMint(headers, mint.id);

        try {
          await acknowledgeAvatarApologyGrant(headers, {
            resolution: 'selected',
            generationId: mint.id,
          });
        } catch {
          // Fast path only; select already latched it server-side.
        }

        settleLocally(address);
      } catch (error) {
        // Only reached when the pick itself failed. Keep the flow open — he asked
        // for an avatar and did not get one.
        showAlert(
          'Could not set your avatar',
          error instanceof Error ? error.message : 'Try again in a moment.',
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
        setSelectingId(null);
      }
    },
    [address, settleLocally, unlockForAppSession],
  );

  const handleKeep = useCallback(async () => {
    if (busyRef.current || !address) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair) {
        showAlert(
          'Approval needed',
          'We could not confirm it was you. Your avatars are yours either way — we will show this again next time you open Sakura.',
        );
        settleLocally(address);
        return;
      }
      const headers = buildAvatarAuthHeaders(keypair);
      // Dismissing requires the apology to have been shown server-side, which
      // only grant-detail does. Fetch it first so a user who never opened the
      // picker can still dismiss for good.
      const detail = await fetchAvatarApologyGrantDetail(headers);
      if (!detail.resolved) {
        await acknowledgeAvatarApologyGrant(headers, { resolution: 'dismissed' });
      }
      settleLocally(address);
    } catch {
      // Fail-safe direction is "ask again", never "lose it". The card footnote
      // deliberately does not promise otherwise.
      showAlert(
        'Saved for later',
        'We could not save that just now, so we will ask once more next time. Your avatars are already in your wallet.',
      );
      settleLocally(address);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [address, settleLocally, unlockForAppSession]);

  if (!grant) return null;

  // Exactly one RN Modal is mounted at a time — nesting one inside another
  // misbehaves on iOS.
  if (stage === 'picker') {
    return (
      <AvatarMintPickerModal
        visible
        mints={avatars}
        selectingId={selectingId}
        busy={busy}
        title="Pick your profile picture"
        subtitle="All of these are already yours. The ones you don't pick stay in your wallet."
        emptyText="Your avatars are still being prepared."
        onClose={() => {
          if (!busyRef.current) setStage('card');
        }}
        onSelect={handleSelect}
      />
    );
  }

  return (
    <AvatarApologyModal
      visible
      grant={grant}
      busy={busy}
      onPick={handlePick}
      onKeep={handleKeep}
      onLater={handleLater}
    />
  );
}
