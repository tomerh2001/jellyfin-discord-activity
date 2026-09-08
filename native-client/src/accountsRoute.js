import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export const ACCOUNT_ROUTE_PATHS = ['login', 'selectserver', 'addserver', 'forgotpassword', 'forgotpasswordpin'];

/** Native account links open the broker's native dialog in the same document. */
export default function NativeAccountsRoute() {
    const navigate = useNavigate();
    useEffect(() => {
        let cancelled = false;
        const home = () => { if (!cancelled) navigate('/home', { replace: true }); };
        // RootAppRouter imports route definitions during initialization. Defer
        // the adapter import until mount to avoid a router/runtime import cycle.
        import('./runtime').then(module => module.openAccounts()).then(home, home);
        return () => { cancelled = true; };
    }, [navigate]);
    return null;
}
