import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import Admin from './pages/Admin'
import Chat from './pages/Chat'
import Clients from './pages/Clients'
import Dashboard from './pages/Dashboard'
import Login from './pages/Login'
import Meetings from './pages/Meetings'
import NewMeeting from './pages/NewMeeting'
import People from './pages/People'
import ProjectDetail from './pages/ProjectDetail'
import Projects from './pages/Projects'
import ResetPassword from './pages/ResetPassword'
import Resources from './pages/Resources'
import Settings from './pages/Settings'
import Welcome from './pages/Welcome'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Magic-link invites land here (handles its own signed-in / expired-link states). */}
      <Route path="/welcome" element={<Welcome />} />
      {/* "Reset your password" emails land here. */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/meetings" element={<Meetings />} />
        <Route path="/meetings/new" element={<NewMeeting />} />
        <Route path="/meetings/:meetingId" element={<Meetings />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/chat/:channelId" element={<Chat />} />
        <Route path="/people" element={<People />} />
        {/* The old Team page grew into People. */}
        <Route path="/team" element={<Navigate to="/people" replace />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/clients/:clientId" element={<Clients />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      {/* "/" and unknown paths: into the app (RequireAuth sends signed-out users to /login). */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}

export default App
