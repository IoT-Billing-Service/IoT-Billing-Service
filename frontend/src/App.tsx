import { Routes, Route, NavLink } from 'react-router-dom';
import { DeviceList } from './components/DeviceList';
import { LiveStream } from './components/LiveStream';

export default function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <nav style={{ padding: '1rem', borderBottom: '1px solid #ddd' }}>
        <NavLink to="/" style={{ marginRight: '1rem' }}>
          Devices
        </NavLink>
        <NavLink to="/live">Live Telemetry</NavLink>
      </nav>
      <main style={{ padding: '1rem' }}>
        <Routes>
          <Route path="/" element={<DeviceList />} />
          <Route path="/live" element={<LiveStream />} />
        </Routes>
      </main>
    </div>
  );
}
