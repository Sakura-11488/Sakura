import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import AvatarApologyModal from '@/components/AvatarApologyModal';
import AvatarMintPickerModal from '@/components/social/AvatarMintPickerModal';
import {
  acknowledgeAvatarApologyGrant,
  AvatarForgeError,
  buildAvatarAuthHeaders,
  fetchAvatarApologyGrantDetail,
  fetchAvatarApologyGrantStatus,
  generateUserAvatar,
  selectAvatarMint,
  type AvatarApologyGrantDetail,
  type AvatarApologyGrantStatus,
  type AvatarMintItem,
} from '@/lib/user-avatar';

/** Long enough for AnimatedSplash to finish; a Modal paints above it regardless
 *  of sibling order, and opening on top of the splash is a bad first frame. */
const FIRST_CHECK_DELAY_MS = 1800;

/** Fold a signed grant-detail back into the card's state without losing fields
 *  the detail payload does not carry. Blind-spreading it blanked preview_urls
 *  and told a user with two avatars that he had four. */
function mergeDetail(
  prev: AvatarApologyGrantStatus,
  detail: AvatarApologyGrantDetail,
): AvatarApologyGrantStatus {
  return {
    ...prev,
    resolved: detail.resolved,
    ready: detail.ready,
    avatar_count: detail.avatar_count || prev.avatar_count,
    minted_count: detail.minted_count,
    credits_remaining: detail.credits_remaining,
    credits_in_review: detail.credits_in_review,
    credits_paused: detail.credits_paused,
    preview_urls: detail.avatars.length
      ? detail.avatars.map((a) => a.public_url ?? '').filter(Boolean)
      : prev.preview_urls,
  };
}

/**
 * Shows the one-time apology to a wallet that was charged SAKURA and received
 * nothing, forges the free avatars it is owed, and lets them pick one as their
 * profile picture.
 *
 * Wallet-keyed rather than session-keyed (the CloudSyncBridge pattern, not the
 * AppUpdateBridge one): the durable "already decided" latch lives in Postgres, so
 * it survives reinstalls and follows the user between the APK and the web PWA.
 * The in-memory ref here only saves repeat requests within one process.
 *
 * Nothing about the forge is checkpointed on the device. The truth is the credit
 * slots in Postgres, so closing the app after two of four and coming back
 * continues at three — on any device, and without the double-mint risk a
 * per-device checkpoint would carry.
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
  const [forging, setForging] = useState<{ index: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    setForging(null);
    setNotice(null);
    setBusy(false);
    busyRef.current = false;
  }, []);

  const check = useCallback(async (wallet: string) => {
    // busyRef matters as much as inFlightRef: an AppState 'active' during a
    // forge — i.e. every time he glances at another app — would otherwise reset
    // the stage and stomp live progress.
    if (inFlightRef.current || busyRef.current || settledRef.current === wallet) return;
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
      // `ready` now means "there is something to show": at least one avatar has
      // landed, or at least one is still owed. Under the old "all of them have
      // landed" reading this was false forever and the card never appeared.
      if (!status.ready) return;
      setGrant(status);
      // Refresh the data without yanking him out of the picker.
      setStage((prev) => (prev === 'picker' ? prev : 'card'));
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

  /**
   * Session-only escape. Never touches the wallet, so it can never fail — and
   * deliberately NOT gated on busy: leaving mid-forge is safe. The in-flight
   * request finishes server-side whether or not anyone is listening, the row
   * lands `ready`, and the unspent credits are still in Postgres next launch.
   */
  const handleLater = useCallback(() => {
    settleLocally(address ?? null);
  }, [address, settleLocally]);

  /**
   * Forge the free avatars this wallet is still owed, one at a time.
   *
   * Sequential on purpose: concurrent calls would race each other for the same
   * credit slot and hammer FLUX and the mint authority's SOL for no gain. A
   * failure does NOT abort the run — it moves to the next slot, because one
   * poisoned prompt must not strand every remaining avatar. Nothing is rolled
   * back; every success stays.
   */
  const forgeGrantedAvatars = useCallback(
    async (
      wallet: string,
      keypair: Parameters<typeof buildAvatarAuthHeaders>[0],
      credits: number,
      have: AvatarMintItem[],
    ): Promise<{ minted: AvatarMintItem[]; failures: number; lastError: string | null; stop: boolean }> => {
      const minted: AvatarMintItem[] = [...have];
      let failures = 0;
      let lastError: string | null = null;

      for (let i = 0; i < credits; i += 1) {
        // "Not now" mid-forge. Stop before starting another: the credit stays
        // unspent and next launch offers it again.
        if (settledRef.current === wallet) return { minted, failures, lastError, stop: true };

        setForging({ index: i + 1, total: credits });
        try {
          const result = await generateUserAvatar({
            // The server varies the look by credit slot; alternating the mode as
            // well keeps a taste-less wallet's four from rhyming.
            mode: (have.length + i) % 2 === 0 ? 'tastes' : 'general',
            // No payment signature at all — that is what tells the server to
            // spend a credit. sendSakura is never called on this path.
            authHeaders: buildAvatarAuthHeaders(keypair),
          });

          if (!result.public_url || !result.mint_address) {
            failures += 1;
            lastError = result.error || 'One of them did not come through.';
            continue;
          }

          minted.push({
            id: result.id,
            mint_address: result.mint_address,
            public_url: result.public_url,
            mode: result.mode ?? 'tastes',
            created_at: new Date().toISOString(),
            is_active: false,
          });

          // Keep the card honest as they land: real thumbnails replace the
          // placeholders and the copy moves to "2 already minted, 2 waiting".
          setGrant((prev) =>
            prev
              ? {
                  ...prev,
                  minted_count: prev.minted_count + 1,
                  credits_remaining:
                    typeof result.credits_remaining === 'number'
                      ? result.credits_remaining
                      : Math.max(0, prev.credits_remaining - 1),
                  preview_urls: [...prev.preview_urls, result.public_url as string].slice(0, 4),
                }
              : prev,
          );

          // The server is the authority on how many are left. Trusting the count
          // captured at loop start is how a second device's forge turns into a
          // "A confirmed SAKURA payment of 100,000 is required." on this card.
          if (result.credits_remaining === 0) {
            return { minted, failures, lastError, stop: false };
          }
        } catch (error) {
          failures += 1;
          if (error instanceof AvatarForgeError) {
            // Nothing was spent, and nothing is left to spend. Stop quietly.
            if (error.code === 'no_credits_left') {
              return { minted, failures, lastError, stop: false };
            }
            // Another request holds this slot right now. Stop rather than
            // fighting it; it will be there next time.
            if (error.code === 'mint_in_flight' || error.status === 409) {
              return {
                minted,
                failures,
                lastError:
                  'One of them is already being forged. Give it a moment and open Sakura again.',
                stop: false,
              };
            }
          }
          lastError = error instanceof Error ? error.message : 'One of them did not come through.';
        }
      }

      return { minted, failures, lastError, stop: false };
    },
    [],
  );

  /**
   * The card's primary action: forge what is owed, then pick. Once the credits
   * are gone this is the original "open the picker" path unchanged.
   */
  const handlePrimary = useCallback(async () => {
    if (busyRef.current || !address) return;
    const wallet = address;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair) {
        // Do NOT trap the user behind a credential operation that can fail.
        showAlert(
          'Approval needed',
          'We could not confirm it was you, so nothing changed. Nothing was charged, and we will show this again next time you open Sakura.',
        );
        settleLocally(wallet);
        return;
      }

      // This call is what marks the apology as SHOWN server-side — which is what
      // unlocks resolution later — and it is the authority on how many credits
      // are left, so a resumed session forges the remaining two rather than
      // restarting at four.
      const detail = await fetchAvatarApologyGrantDetail(buildAvatarAuthHeaders(keypair));
      if (detail.resolved) {
        settleLocally(wallet);
        return;
      }
      setGrant((prev) => (prev ? mergeDetail(prev, detail) : prev));

      let owned = detail.avatars;

      if (detail.credits_remaining > 0) {
        const outcome = await forgeGrantedAvatars(
          wallet,
          keypair,
          detail.credits_remaining,
          detail.avatars,
        );
        owned = outcome.minted;

        // He left mid-forge. Everything minted is already in his wallet and in
        // the ordinary picker; the card comes back next launch.
        if (outcome.stop || settledRef.current === wallet) return;

        // Never assert "nothing was used up" from the client — a request that
        // died after the server minted would make that false. Ask the server
        // what actually happened and let the numbers on the card speak.
        if (outcome.failures > 0) {
          try {
            const after = await fetchAvatarApologyGrantDetail(buildAvatarAuthHeaders(keypair));
            setGrant((prev) => (prev ? mergeDetail(prev, after) : prev));
            owned = after.avatars.length ? after.avatars : owned;
          } catch {
            // Keep what we have; the message below stays deliberately vague.
          }
          setAvatars(owned);
          setNotice(
            `${outcome.lastError ?? 'One of them did not come through.'} The count above is what you actually have right now.`,
          );
          return;
        }
      }

      if (owned.length === 0) {
        // The in-review and paused notices already say what is going on; do not
        // stack a second, vaguer one on top of them.
        if (detail.credits_in_review <= 0 && detail.credits_paused <= 0) {
          setNotice('We could not forge them just now. Nothing was charged — try again in a moment.');
        }
        return;
      }

      setAvatars(owned);
      setStage('picker');
    } catch (error) {
      showAlert(
        'Could not load your avatars',
        error instanceof Error ? error.message : 'Try again in a moment.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      setForging(null);
    }
  }, [address, forgeGrantedAvatars, settleLocally, unlockForAppSession]);

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

        // The select IS the resolution — but only once nothing is still owed.
        // The server refuses to latch a grant with credits outstanding, so a
        // pick can never quietly retire avatars he has not claimed.
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
          'We could not confirm it was you. Nothing was charged either way — we will show this again next time you open Sakura.',
        );
        settleLocally(address);
        return;
      }
      const headers = buildAvatarAuthHeaders(keypair);
      // Dismissing requires the apology to have been shown server-side, which
      // only grant-detail does. Fetch it first so a user who never forged
      // anything can still dismiss for good — under the old "all avatars have
      // landed" gate this call refused to stamp shown_at and dismissal could
      // never stick at all.
      const detail = await fetchAvatarApologyGrantDetail(headers);
      if (!detail.resolved) {
        await acknowledgeAvatarApologyGrant(headers, { resolution: 'dismissed' });
      }
      if (detail.credits_remaining > 0) {
        // Dismissal stops the CARD. It does not forfeit the avatars, and saying
        // so is the difference between a kept promise and a quiet one.
        showAlert(
          'We won’t ask again',
          `Your ${detail.credits_remaining} free avatar${detail.credits_remaining === 1 ? '' : 's'} ${
            detail.credits_remaining === 1 ? 'is' : 'are'
          } still yours. Tap your profile picture whenever you want ${
            detail.credits_remaining === 1 ? 'it' : 'them'
          } — nothing will be charged.`,
        );
      }
      settleLocally(address);
    } catch {
      // Fail-safe direction is "ask again", never "lose it". The card footnote
      // deliberately does not promise otherwise.
      showAlert(
        'Saved for later',
        'We could not save that just now, so we will ask once more next time. Nothing was charged, and anything already forged is in your wallet.',
      );
      settleLocally(address);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [address, settleLocally, unlockForAppSession]);

  if (!grant) return null;

  // Exactly one RN Modal is mounted at a time — nesting one inside another
  // misbehaves on iOS. Forging is therefore a state OF the card, not a third
  // modal.
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
      forging={forging}
      error={notice}
      onPrimary={handlePrimary}
      onKeep={handleKeep}
      onLater={handleLater}
    />
  );
}
