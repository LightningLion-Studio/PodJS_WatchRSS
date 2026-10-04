package dev.podjs.tests.fontscale;

/** Only the isolated Pod startup APK is accepted; its namespace is different. */
public final class PodFontScaleRunner extends IsolatedFontScaleRunner {
    public PodFontScaleRunner() {
        super(FontScalePolicy.POD);
    }
}
