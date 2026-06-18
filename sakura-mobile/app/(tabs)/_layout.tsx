import { Tabs } from 'expo-router';
import CustomTabBar from '@/components/layout/CustomTabBar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index"    options={{ title: 'Home' }}     />
      <Tabs.Screen name="anime"    options={{ title: 'Anime' }}    />
      <Tabs.Screen name="search"   options={{ title: 'Search' }}   />
      <Tabs.Screen name="novel"    options={{ title: 'Novel' }}    />
      <Tabs.Screen name="messages" options={{ title: 'Messages' }} />
      <Tabs.Screen name="profile"  options={{ title: 'Profile' }}  />
      <Tabs.Screen name="library"  options={{ title: 'Library', tabBarButton: () => null }} />
      {/* settings is navigated to from profile — not shown in tab bar */}
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarButton: () => null }} />
    </Tabs>
  );
}
