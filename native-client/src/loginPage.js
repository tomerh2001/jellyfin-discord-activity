import loading from 'components/loading/loading';
import { mountLoginPage } from './loginPageCore';

export default function LoginPage(view) {
    // Deferred import avoids the router/runtime initialization cycle.
    view.addEventListener('viewshow', () => loading.hide());
    mountLoginPage(view, () => import('./runtime'));
}
