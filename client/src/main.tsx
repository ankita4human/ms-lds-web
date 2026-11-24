import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { auth } from './api';
import Login from './Login';
import Shell from './Shell';
import { PageLoader } from './components/Loader';
// Pages (and the chart library) load on demand, so the first screen opens faster.
const Dashboard = lazy(() => import('./Dashboard'));
const Documents = lazy(() => import('./Documents'));
const Analytics = lazy(() => import('./Analytics'));
const FilterManagement = lazy(() => import('./FilterManagement'));
const TypeManagement = lazy(() => import('./TypeManagement'));
const StandardManagement = lazy(() => import('./StandardManagement'));
const DependencyManagement = lazy(() => import('./DependencyManagement'));
const UserManagement = lazy(() => import('./UserManagement'));
const EmailDistribution = lazy(() => import('./EmailDistribution'));
import './theme.css';
import { LangProvider } from './LangContext';

// Keep data for 5 minutes and do not refetch on window focus: the dashboard queries are heavy.
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60_000, gcTime: 15 * 60_000, refetchOnWindowFocus: false, retry: 1 } } });
const Guard = ({ children }: { children: React.ReactElement }) => (auth.get() ? children : <Navigate to="/login" replace />);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Guard><LangProvider><Shell /></LangProvider></Guard>}>
          <Route index element={<Suspense fallback={<PageLoader />}><Dashboard /></Suspense>} />
          <Route path="analytics" element={<Suspense fallback={<PageLoader />}><Analytics /></Suspense>} />
          <Route path="documents" element={<Suspense fallback={<PageLoader />}><Documents /></Suspense>} />
          <Route path="options/filters" element={<Suspense fallback={<PageLoader />}><FilterManagement /></Suspense>} />
          <Route path="options/types" element={<Suspense fallback={<PageLoader />}><TypeManagement /></Suspense>} />
          <Route path="options/standards" element={<Suspense fallback={<PageLoader />}><StandardManagement /></Suspense>} />
          <Route path="options/dependency" element={<Suspense fallback={<PageLoader />}><DependencyManagement /></Suspense>} />
          <Route path="options/users" element={<Suspense fallback={<PageLoader />}><UserManagement /></Suspense>} />
          <Route path="options/distribution" element={<Suspense fallback={<PageLoader />}><EmailDistribution /></Suspense>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>
);
