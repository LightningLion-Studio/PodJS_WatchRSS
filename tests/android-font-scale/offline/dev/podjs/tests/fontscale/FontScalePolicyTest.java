package dev.podjs.tests.fontscale;

/** Runs the exact policy shared by both AndroidJUnitRunner entries, without Android stubs. */
public final class FontScalePolicyTest {
    private static int assertions;

    public static void main(String[] args) {
        verifyPolicy(FontScalePolicy.NATIVE, FontScalePolicy.POD);
        verifyPolicy(FontScalePolicy.POD, FontScalePolicy.NATIVE);
        check(FontScalePolicy.NATIVE.acceptsActivity("com.lightningstudio.watchrss.BeianActivity"));
        check(FontScalePolicy.NATIVE.acceptsActivity("com.lightningstudio.watchrss.InfoActivity"));
        check(FontScalePolicy.POD.acceptsActivity("dev.podjs.androidwatch.MainActivity"));
        String[] rejectedActivities = {null, "", "BeianActivity", "InfoActivity", "MainActivity",
                "com.lightningstudio.watchrss.onboardingreference.BeianActivity",
                "dev.podjs.tests.startup.MainActivity", "android.app.Activity",
                "com.lightningstudio.watchrss.BeianActivitySubclass",
                "dev.podjs.androidwatch.MainActivity$Fake"};
        for (String activity : rejectedActivities) {
            check(!FontScalePolicy.NATIVE.acceptsActivity(activity));
            check(!FontScalePolicy.POD.acceptsActivity(activity));
        }
        check(!FontScalePolicy.NATIVE.acceptsActivity("dev.podjs.androidwatch.MainActivity"));
        check(!FontScalePolicy.POD.acceptsActivity("com.lightningstudio.watchrss.BeianActivity"));
        check(!FontScalePolicy.POD.acceptsActivity("com.lightningstudio.watchrss.InfoActivity"));
        System.out.println("FontScalePolicyTest: " + assertions + " assertions passed");
    }

    private static void verifyPolicy(FontScalePolicy policy, FontScalePolicy other) {
        for (String scale : new String[] {"1.0", "1.3", "1.8"}) {
            float actual = policy.validate(policy.targetPackage, policy.testPackage, policy.runnerClass, scale);
            check(Float.floatToIntBits(actual) == Float.floatToIntBits(Float.parseFloat(scale)));
            verifyIdentityGuards(policy, other, scale);
        }
        Object[] rejectedScaleArguments = {null, "", "1", "1.00", "+1.0", "1e0", "1.0f",
                " 1.0", "1.0 ", "1,0", "1.30", "1.80", "1.3000", " 1.3", "1.8 ",
                "1,3", "NaN", "Infinity", "-1.3", "1.5", "13e-1", 1, 1.0f, 1.0d, 1.3f, 1.8d};
        for (Object value : rejectedScaleArguments) {
            reject(() -> policy.validate(policy.targetPackage, policy.testPackage, policy.runnerClass, value));
        }
    }

    private static void verifyIdentityGuards(FontScalePolicy policy, FontScalePolicy other, String scale) {
        String[] wrongTargets = {null, "", "com.lightningstudio.watchrss", "dev.podjs.androidwatch",
                policy.targetPackage + ".debug", policy.targetPackage + ".test", other.targetPackage};
        for (String target : wrongTargets) {
            reject(() -> policy.validate(target, policy.testPackage, policy.runnerClass, scale));
        }
        for (String test : new String[] {null, "", policy.targetPackage, other.testPackage,
                policy.testPackage + ".debug", "com.lightningstudio.watchrss.test"}) {
            reject(() -> policy.validate(policy.targetPackage, test, policy.runnerClass, scale));
        }
        for (String runner : new String[] {null, "", other.runnerClass,
                "androidx.test.runner.AndroidJUnitRunner", policy.runnerClass + "Subclass"}) {
            reject(() -> policy.validate(policy.targetPackage, policy.testPackage, runner, scale));
        }
    }

    private static void reject(Runnable action) {
        try {
            action.run();
        } catch (IllegalStateException expected) {
            assertions++;
            return;
        }
        throw new AssertionError("Expected rejected runner configuration");
    }

    private static void check(boolean value) {
        assertions++;
        if (!value) throw new AssertionError("Policy assertion " + assertions + " failed");
    }
}
