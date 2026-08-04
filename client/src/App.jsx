import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, RequireRole, useAuth } from './auth';
import { ToastProvider, Spinner } from './components/ui';
import { InvestorLayout, AdminLayout } from './components/layouts';

// Auth (Stages 2-3)
const Login = lazy(() => import('./pages/auth/Login'));
const Register = lazy(() => import('./pages/auth/Register'));
const VerifyOtp = lazy(() => import('./pages/auth/VerifyOtp'));
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'));
// Investor (Stages 4-13)
const Home = lazy(() => import('./pages/investor/Home'));
const Kyc = lazy(() => import('./pages/investor/Kyc'));
const Bank = lazy(() => import('./pages/investor/Bank'));
const Funds = lazy(() => import('./pages/investor/Funds'));
const Trade = lazy(() => import('./pages/investor/Trade'));
const Markets = lazy(() => import('./pages/investor/Markets'));
const Fno = lazy(() => import('./pages/investor/Fno'));
const Ipo = lazy(() => import('./pages/investor/Ipo'));
const Orders = lazy(() => import('./pages/investor/Orders'));
const Portfolio = lazy(() => import('./pages/investor/Portfolio'));
const Transactions = lazy(() => import('./pages/investor/Transactions'));
const Withdraw = lazy(() => import('./pages/investor/Withdraw'));
const Notifications = lazy(() => import('./pages/investor/Notifications'));
// Administrator Console (Stages 4/5/8/11/14, Sections 4 & 6)
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const NotificationCentre = lazy(() => import('./pages/admin/NotificationCentre'));
const Investors = lazy(() => import('./pages/admin/Investors'));
const InvestorDetail = lazy(() => import('./pages/admin/InvestorDetail'));
const KycQueue = lazy(() => import('./pages/admin/KycQueue'));
const BankQueue = lazy(() => import('./pages/admin/BankQueue'));
const AdminDeposits = lazy(() => import('./pages/admin/Deposits'));
const OrdersQueue = lazy(() => import('./pages/admin/OrdersQueue'));
const AdminWithdrawals = lazy(() => import('./pages/admin/Withdrawals'));
const Reports = lazy(() => import('./pages/admin/Reports'));
const FeedMonitor = lazy(() => import('./pages/admin/FeedMonitor'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage'));
const PasswordResets = lazy(() => import('./pages/admin/PasswordResets'));

function RootRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'admin' ? '/admin' : '/app'} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Suspense fallback={<div className="page-loading"><Spinner /></div>}>
            <Routes>
              <Route path="/" element={<RootRedirect />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/verify-otp" element={<VerifyOtp />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />

              <Route path="/app" element={<RequireRole role="investor"><InvestorLayout /></RequireRole>}>
                <Route index element={<Home />} />
                <Route path="kyc" element={<Kyc />} />
                <Route path="bank" element={<Bank />} />
                <Route path="funds" element={<Funds />} />
                <Route path="trade" element={<Trade />} />
                <Route path="markets" element={<Markets />} />
                <Route path="fno" element={<Fno />} />
                <Route path="ipo" element={<Ipo />} />
                <Route path="orders" element={<Orders />} />
                <Route path="portfolio" element={<Portfolio />} />
                <Route path="transactions" element={<Transactions />} />
                <Route path="withdraw" element={<Withdraw />} />
                <Route path="notifications" element={<Notifications />} />
              </Route>

              <Route path="/admin" element={<RequireRole role="admin"><AdminLayout /></RequireRole>}>
                <Route index element={<AdminDashboard />} />
                <Route path="notifications" element={<NotificationCentre />} />
                <Route path="investors" element={<Investors />} />
                <Route path="investors/:id" element={<InvestorDetail />} />
                <Route path="kyc" element={<KycQueue />} />
                <Route path="bank" element={<BankQueue />} />
                <Route path="deposits" element={<AdminDeposits />} />
                <Route path="orders" element={<OrdersQueue />} />
                <Route path="withdrawals" element={<AdminWithdrawals />} />
                <Route path="reports" element={<Reports />} />
                <Route path="feed" element={<FeedMonitor />} />
                <Route path="password-resets" element={<PasswordResets />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>

              <Route path="*" element={<RootRedirect />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
