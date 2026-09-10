/** Adapt native Jellyfin form events without sending credentials to a browser gateway. */
export function mountLoginPage(view, getRuntime) {
    const form = view.querySelector('.manualLoginForm');
    const server = view.querySelector('#txtActivityServer');
    const username = view.querySelector('#txtManualName');
    const password = view.querySelector('#txtManualPassword');
    const community = view.querySelector('.btnCommunity');
    const status = view.querySelector('.activityLoginStatus');
    let active = true;
    let pending;
    let sequence = 0;
    let options;
    const controls = [...form.querySelectorAll('input, button')];
    const update = () => {
        for (const control of controls) control.disabled = Boolean(pending) || !options;
        server.readOnly = Boolean(options?.partyServerUrl);
    };
    const isCurrent = generation => active && sequence === generation;
    async function load(message) {
        active = true;
        const generation = ++sequence;
        if (pending) pending.input.password = '';
        pending = undefined;
        options = undefined;
        view.querySelector('.btnLoginRetry').classList.add('hide');
        status.textContent = message || 'Connecting…';
        update();
        try {
            const runtime = await getRuntime();
            const result = await runtime.getLoginOptions();
            if (!isCurrent(generation)) return;
            options = result;
            server.value = options.partyServerUrl || options.defaultServerUrl;
            community.classList.toggle('hide', !options.communityAvailable);
            status.textContent = message || (options.partyServerUrl ? 'Sign in to join this watch party.' : '');
        } catch {
            if (isCurrent(generation)) {
                status.textContent = message ? `${message} Could not refresh the server. Try again.` : 'Could not connect. Try again.';
                view.querySelector('.btnLoginRetry').classList.remove('hide');
            }
        } finally { if (isCurrent(generation)) update(); }
    }
    async function signIn(useCommunity) {
        if (!active || pending || !options || (useCommunity && !options.communityAvailable)) return;
        const generation = sequence;
        const input = { serverUrl: options.partyServerUrl || server.value.trim(), username: username.value.trim(), password: password.value };
        const attempt = { input };
        pending = attempt;
        password.value = '';
        status.textContent = 'Signing in…';
        update();
        try {
            const runtime = await getRuntime();
            if (!isCurrent(generation)) return;
            await runtime.loginJellyfin(useCommunity ? null : input, () => isCurrent(generation));
        } catch (error) {
            if (isCurrent(generation)) {
                // Another viewer may have selected the party's server while
                // this form was open. Refresh once, preserving the login error
                // and username; a failed refresh requires the native Retry.
                await load(error instanceof Error ? error.message : 'Could not sign in. Try again.');
            }
        } finally {
            input.password = '';
            if (pending === attempt) pending = undefined;
            if (isCurrent(generation)) update();
        }
    }
    form.addEventListener('submit', event => { event.preventDefault(); void signIn(false); });
    community.addEventListener('click', () => { void signIn(true); });
    view.querySelector('.btnLoginRetry').addEventListener('click', event => { event.currentTarget.classList.add('hide'); void load(); });
    view.addEventListener('viewshow', () => { if (!active) void load(); });
    const hide = () => {
        active = false;
        sequence++;
        password.value = '';
        if (pending) pending.input.password = '';
        pending = undefined;
    };
    view.addEventListener('viewbeforehide', hide);
    view.addEventListener('viewdestroy', hide);
    void load();
}
