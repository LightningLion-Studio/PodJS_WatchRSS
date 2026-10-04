package dev.podjs.tests.fontscale;

/** Only the isolated native onboarding reference APK is accepted. */
public final class NativeFontScaleRunner extends IsolatedFontScaleRunner {
    public NativeFontScaleRunner() {
        super(FontScalePolicy.NATIVE);
    }
}
