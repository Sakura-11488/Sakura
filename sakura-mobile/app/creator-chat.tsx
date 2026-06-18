import { Redirect, useLocalSearchParams } from 'expo-router';

/** Legacy route — redirects to the unified messages thread screen. */
export default function CreatorChatRedirect() {
  const params = useLocalSearchParams<{
    thread?: string;
    wallet?: string;
    peer_username?: string;
    peer_display_name?: string;
  }>();

  const threadId = params.thread?.trim();
  if (!threadId) {
    return <Redirect href="/(tabs)/messages" />;
  }

  return (
    <Redirect
      href={{
        pathname: '/messages/[threadId]',
        params: {
          threadId,
          peerName: params.peer_display_name?.trim() || undefined,
          peerUsername: params.peer_username?.trim() || undefined,
          peerSeed: params.wallet?.trim()?.slice(0, 8) || undefined,
        },
      } as never}
    />
  );
}
