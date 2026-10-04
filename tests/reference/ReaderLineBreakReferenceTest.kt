package dev.podjs.androidwatch.reference

import android.content.Intent
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.io.File

class ReaderLineBreakReferenceTest {
    @Test fun captureProductionLineBreaksAndPlatformComparison() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assertEquals("com.lightningstudio.watchrss.reference", context.packageName)
        val output = File(context.getExternalFilesDir(null), "reference-reader-line-breaks.json")
        output.delete()
        val fonts = File(context.getExternalFilesDir(null), "reference-reader-fonts.json")
        fonts.delete()
        val activity = instrumentation.startActivitySync(Intent().setClassName(context.packageName, "dev.podjs.androidwatch.reference.ReferenceRssActivity").putExtra("reader-layout-probe", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            val deadline = SystemClock.uptimeMillis() + 60000
            var data: JSONObject? = null
            while (SystemClock.uptimeMillis() < deadline) {
                data = runCatching { JSONObject(output.readText()) }.getOrNull()
                if (data?.optBoolean("complete") == true) break
                SystemClock.sleep(150)
            }
            assertTrue("layout capture incomplete", data?.optBoolean("complete") == true)
            assertEquals(288, data!!.getInt("expectedCases"))
            val fontData = JSONObject(fonts.readText())
            assertTrue(fontData.getBoolean("complete"))
            assertEquals(3, fontData.getJSONArray("probes").length())
            val probes = fontData.getJSONArray("probes")
            for (index in 0 until probes.length()) {
                val samples = probes.getJSONObject(index).getJSONArray("samples")
                for (sampleIndex in 0 until samples.length()) {
                    val sample = samples.getJSONObject(sampleIndex)
                    assertEquals(sample.getJSONObject("default").getDouble("width"), sample.getJSONObject("compose").getDouble("width"), 0.001)
                }
            }
            val cases = data.getJSONArray("cases")
            assertEquals(288, cases.length())
            for (i in 0 until cases.length()) {
                val case = cases.getJSONObject(i)
                val ends = case.getJSONArray("composeEnds")
                assertTrue(ends.length() > 0)
                assertEquals(case.getString("text").length, ends.getInt(ends.length() - 1))
            }
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
