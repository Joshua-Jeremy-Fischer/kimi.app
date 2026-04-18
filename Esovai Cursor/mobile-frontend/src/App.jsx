import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider } from '@/lib/AuthContext';
import MobileLayout from './components/MobileLayout';
import ChatList from './pages/ChatList';
import ChatView from './pages/ChatView';
import AgentScreen from './pages/AgentScreen';
import SettingsScreen from './pages/SettingsScreen';
import InboxScreen from './pages/InboxScreen';
import OpenClawScreen from './pages/OpenClawScreen';

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <Routes>
            <Route element={<MobileLayout />}>
              <Route path="/" element={<ChatList />} />
              <Route path="/inbox" element={<InboxScreen />} />
              <Route path="/agent" element={<AgentScreen />} />
              <Route path="/openclaw" element={<OpenClawScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
            </Route>
            <Route path="/chat/:chatId" element={<ChatView />} />
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App
