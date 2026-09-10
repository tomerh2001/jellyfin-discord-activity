/** Keep Jellyfin's login markup and web components, adapted to the broker. */
export async function patchLoginPage(replace) {
    const file = 'src/apps/legacy/controllers/session/login/index.html';
    await replace(file, 'manualLoginForm margin-auto-x hide', 'manualLoginForm margin-auto-x');
    await replace(file, '                <input is="emby-input" type="text" id="txtManualName"', `                <input is="emby-input" type="url" id="txtActivityServer" required="required" label="Jellyfin server" autocomplete="url" autocapitalize="off" placeholder="https://jellyfin.example.com" />
            </div>
            <p class="activityLoginStatus" role="status" aria-live="polite"></p>
            <div class="inputContainer">
                <input is="emby-input" type="text" id="txtManualName"`);
    await replace(file, `            <label class="checkboxContainer">
                <input is="emby-checkbox" type="checkbox" class="chkRememberLogin" checked />
                <span>\${RememberMe}</span>
            </label>`, '');
    await replace(file, `            <div style="margin-top:.5em;">
                <button is="emby-button" type="button" class="raised cancel block btnCancel">
                    <span>\${ButtonCancel}</span>
                </button>
            </div>`, `            <button is="emby-button" type="button" class="raised block btnCommunity hide">
                <span>Sign in as community user</span>
            </button>`);
    await replace(file, `        <div class="visualLoginForm" style="text-align: center;">
            <h1 style="margin-top:1em;">\${HeaderPleaseSignIn}</h1>
            <div id="divUsers" class="itemsContainer vertical-wrap centered"></div>
        </div>`, '');
    await replace(file, `        <div class="readOnlyContent" style="margin: .5em auto 1em;">
            <button is="emby-button" type="button" class="raised cancel block btnManual">
                <span>\${ButtonManualLogin}</span>
            </button>

            <button is="emby-button" type="button" class="raised cancel block btnQuick hide">
                <span>\${ButtonUseQuickConnect}</span>
            </button>

            <button is="emby-button" type="button" class="raised cancel block btnForgotPassword">
                <span>\${ButtonForgotPassword}</span>
            </button>

            <button is="emby-button" type="button" class="raised block btnSelectServer">
                <span>\${ButtonChangeServer}</span>
            </button>

            <div class="loginDisclaimerContainer">
                <div class="loginDisclaimer"></div>
            </div>
        </div>`, `        <div class="readOnlyContent" style="margin: .5em auto 1em;">
            <button is="emby-button" type="button" class="raised block btnLoginRetry hide"><span>Try again</span></button>
        </div>`);
    await replace('src/scripts/autoBackdrops.js',
        `    const api = ServerConnections.getApi();
    const brandingOptions = await queryClient.fetchQuery(getBrandingOptionsQuery(api));`,
        `    const api = ServerConnections.getApi();
    if (!api) { clearBackdrop(); return; }
    const brandingOptions = await queryClient.fetchQuery(getBrandingOptionsQuery(api));
    if (ServerConnections.getApi() !== api) return;`);

}
