import React from 'react';
import ViewManagerPage from 'components/viewManager/ViewManagerPage';

export const ACCOUNT_ROUTE_PATHS = ['login', 'selectserver', 'addserver', 'forgotpassword', 'forgotpasswordpin'];

/** Native Jellyfin login, usable before an authenticated API client exists. */
export default function NativeAccountsRoute() {
    return React.createElement(ViewManagerPage, {
        controller: 'session/login/index', view: 'session/login/index.html',
        isNowPlayingBarEnabled: false
    });
}
