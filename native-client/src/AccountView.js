import React, { useSyncExternalStore } from 'react';
import { getAccountView, subscribeAccountView } from './accountViewState';

/** Keep account-owned providers and Modern page controllers in one disposable tree. */
export default function AccountView({ children }) {
    const state = useSyncExternalStore(subscribeAccountView, getAccountView);
    return state.pending ? null : React.createElement(React.Fragment, { key: state.revision }, children);
}
