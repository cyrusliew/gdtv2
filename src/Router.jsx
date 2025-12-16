import { createHashRouter, RouterProvider, Outlet } from 'react-router-dom';
import TVPlayer from './pages/Player/TVPlayer';
import LandingPage from './pages/LandingPage';

const router = createHashRouter([
    {
        path: '/',
        element: <Outlet />,
        children: [
            {
                index: true,
                element: <LandingPage />,
            },
            {
                path: ':tvId',
                element: <TVPlayer />,
            },
        ],
    },
]);

export function Router() {
    return <RouterProvider router={router} />;
}
