/** Keep the Modern application's navigation outside its fullscreen video route. */
export async function patchModernPresentation(replace) {
    await replace('src/apps/modern/AppLayout.tsx',
        '                    <OffsetAppBar dense>',
        "                    {location.pathname !== '/video' && <OffsetAppBar dense>");
    await replace('src/apps/modern/AppLayout.tsx',
        '                    </OffsetAppBar>',
        '                    </OffsetAppBar>}');
}
