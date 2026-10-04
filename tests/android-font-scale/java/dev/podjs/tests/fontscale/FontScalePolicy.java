package dev.podjs.tests.fontscale;

/** Android-independent allowlist used by the real runners and the offline tests. */
final class FontScalePolicy {
    static final FontScalePolicy NATIVE = new FontScalePolicy(
            "com.lightningstudio.watchrss.onboardingreference",
            "dev.podjs.tests.fontscale.NativeFontScaleRunner",
            new String[] {"com.lightningstudio.watchrss.BeianActivity",
                    "com.lightningstudio.watchrss.InfoActivity"});
    static final FontScalePolicy POD = new FontScalePolicy(
            "dev.podjs.tests.startup", "dev.podjs.tests.fontscale.PodFontScaleRunner",
            new String[] {"dev.podjs.androidwatch.MainActivity"});

    final String targetPackage;
    final String testPackage;
    final String runnerClass;
    private final String[] activityClasses;

    private FontScalePolicy(String targetPackage, String runnerClass, String[] activityClasses) {
        this.targetPackage = targetPackage;
        this.testPackage = targetPackage + ".test";
        this.runnerClass = runnerClass;
        this.activityClasses = activityClasses.clone();
    }

    float validate(String target, String test, String runner, Object fontScaleArgument) {
        require(targetPackage.equals(target), "Refusing target package: " + target);
        require(testPackage.equals(test), "Refusing test package: " + test);
        require(runnerClass.equals(runner), "Refusing runner class: " + runner);
        require("1.0".equals(fontScaleArgument) || "1.3".equals(fontScaleArgument)
                        || "1.8".equals(fontScaleArgument),
                "Explicit instrumentation argument -e fontScale 1.0, 1.3 or 1.8 is required");
        return Float.parseFloat((String) fontScaleArgument);
    }

    boolean acceptsActivity(String className) {
        for (String allowed : activityClasses) {
            if (allowed.equals(className)) return true;
        }
        return false;
    }

    static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
