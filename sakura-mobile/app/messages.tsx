import { Redirect } from 'expo-router';

/** Deep links and legacy navigation → Messages tab */
export default function MessagesRedirect() {
  return <Redirect href="/(tabs)/messages" />;
}
