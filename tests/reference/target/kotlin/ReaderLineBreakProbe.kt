package dev.podjs.androidwatch.reference

import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextDirectionHeuristics
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontSynthesis
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lightningstudio.watchrss.data.reader.ReaderLineBreakMode
import com.lightningstudio.watchrss.data.reader.ReaderPreset
import com.lightningstudio.watchrss.ui.reader.LocalReaderPresetRuntime
import com.lightningstudio.watchrss.ui.reader.ReaderPresetRuntime
import com.lightningstudio.watchrss.ui.reader.ReaderTextRole
import com.lightningstudio.watchrss.ui.reader.readerTextStyle
import com.lightningstudio.watchrss.ui.screen.rss.DetailTextBlock
import com.lightningstudio.watchrss.ui.screen.rss.DetailTitle
import androidx.compose.ui.text.TextLayoutResult
import com.lightningstudio.watchrss.ui.util.TextStyle
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** Actual production DetailTextBlock layout; StaticLayout is independently measured for comparison. */
@Composable
fun ReaderLineBreakProbe(output: File) {
    data class Case(val text: String, val width: Int, val size: Int, val mode: ReaderLineBreakMode, val lineHeight: Float, val title: Boolean = false)
    val cases = remember {
        val texts = listOf(
            (0 until 40).joinToString("") { "第${it}句正文甲乙丙丁戊己庚辛壬癸。" },
            "中文（括号不能随意断开），测试：引号“内容”、数字12.34、型号OPPO-X9，以及下一句！",
            "A paragraph with short and considerablylonger words, a model X9 Pro, and punctuation. Another sentence improves the line balancing.",
            "第一段甲乙丙丁。\n第二段带😀表情和é组合字，还有不换行空格A\u00a0B。",
            "", "A short line", "English first line.\n中文第二段。\n\n"
        )
        buildList {
            for (text in texts) for (width in listOf(150, 205)) for (size in listOf(14, 20)) for (mode in ReaderLineBreakMode.entries) for (lineHeight in listOf(1f, 1.35f, 2f)) add(Case(text, width, size, mode, lineHeight))
            for (text in listOf("朗读高亮验证标题", "较长的中文标题测试换行与末行孤字", "A short title")) for (width in listOf(150, 205)) for (size in listOf(14, 20)) for (lineHeight in listOf(1f, 1.35f, 2f)) add(Case(text, width, size, ReaderLineBreakMode.PARAGRAPH, lineHeight, true))
        }
    }
    val results = remember { JSONArray() }
    val fontProbes = remember { JSONArray() }
    var index by remember { mutableIntStateOf(0) }
    var captured by remember { mutableIntStateOf(-1) }
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { kotlinx.coroutines.delay(250); started = true }
    if (!started || index >= cases.size) return
    val at = index
    val case = cases[at]
    key(at) {
        val preset = remember(case) { ReaderPreset.fallback.copy(body = ReaderPreset.fallback.body.copy(fontSizeSp = case.size.toFloat(), lineBreakMode = case.mode, lineHeightEm = case.lineHeight)) }
        CompositionLocalProvider(LocalReaderPresetRuntime provides ReaderPresetRuntime(preset)) {
            val style = readerTextStyle(if (case.title) ReaderTextRole.TITLE else ReaderTextRole.BODY)
            val density = LocalDensity.current
            val context = LocalContext.current
            val resolver = LocalFontFamilyResolver.current
            val family = LocalFontFamilyResolver.current.resolve(style.fontFamily, style.fontWeight ?: FontWeight.Normal, style.fontStyle ?: FontStyle.Normal, style.fontSynthesis ?: FontSynthesis.All).value as Typeface
            val textSizePx = with(density) { style.fontSize.toPx() }
            Box(Modifier.width(case.width.dp)) {
                val capture: (TextLayoutResult) -> Unit = { layout ->
                        if (captured != at) {
                            captured = at
                            val renderedText = layout.layoutInput.text.text
                            val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                                typeface = family; textSize = textSizePx; letterSpacing = preset.body.letterSpacingEm; isSubpixelText = true
                            }
                            val widthPx = layout.layoutInput.constraints.maxWidth
                            val strategy = if (case.mode == ReaderLineBreakMode.PARAGRAPH) Layout.BREAK_STRATEGY_HIGH_QUALITY else Layout.BREAK_STRATEGY_SIMPLE
                            val platform = StaticLayout.Builder.obtain(renderedText, 0, renderedText.length, paint, widthPx)
                                .setIncludePad(false).setAlignment(Layout.Alignment.ALIGN_NORMAL)
                                .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
                                .setBreakStrategy(strategy).setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE).build()
                            val composeEnds = (0 until layout.lineCount).map { layout.getLineEnd(it) }
                            val staticEnds = (0 until platform.lineCount).map { platform.getLineEnd(it) }
                            val lines = JSONArray()
                            for (line in 0 until layout.lineCount) lines.put(JSONObject().put("start", layout.getLineStart(line)).put("end", layout.getLineEnd(line)).put("visibleEnd", layout.getLineEnd(line, true)).put("left", layout.getLineLeft(line)).put("right", layout.getLineRight(line)).put("top", layout.getLineTop(line)).put("bottom", layout.getLineBottom(line)).put("baseline", layout.getLineBaseline(line)))
                            if (case.width == 205 && case.size == 14 && case.mode == ReaderLineBreakMode.PARAGRAPH && case.lineHeight == 1.35f &&
                                ((!case.title && (case.text.startsWith("第0句") || case.text.startsWith("A paragraph"))) || (case.title && case.text == "朗读高亮验证标题"))) {
                                val inputStyle = layout.layoutInput.style
                                val actualFamily = resolver.resolve(inputStyle.fontFamily, inputStyle.fontWeight ?: FontWeight.Normal,
                                    inputStyle.fontStyle ?: FontStyle.Normal, inputStyle.fontSynthesis ?: FontSynthesis.All).value as Typeface
                                val watchFamily = Typeface.create(context.resources.getFont(com.lightningstudio.watchrss.R.font.watch_sans), family.weight, family.isItalic)
                                val defaultFamily = Typeface.create(Typeface.DEFAULT, family.weight, family.isItalic)
                                val faces = listOf("compose" to actualFamily, "default" to defaultFamily, "watch_sans" to watchFamily)
                                val samples = JSONArray()
                                for (sample in listOf("0", "1", "0123456789", "第10句正文", "正文甲乙丙丁戊己庚辛壬癸。", "A short line")) {
                                    val measured = JSONObject().put("text", sample)
                                    for ((name, face) in faces) {
                                        val samplePaint = TextPaint(paint).apply { typeface = face }
                                        val advances = FloatArray(sample.length)
                                        samplePaint.getTextWidths(sample, advances)
                                        measured.put(name, JSONObject().put("width", samplePaint.measureText(sample)).put("advances", JSONArray(advances.map { it.toDouble() })))
                                    }
                                    samples.put(measured)
                                }
                                val positions = JSONArray()
                                for (char in 0 until renderedText.length) {
                                    val box = layout.getBoundingBox(char)
                                    positions.put(JSONObject().put("index", char).put("left", box.left).put("right", box.right).put("top", box.top).put("bottom", box.bottom))
                                }
                                fontProbes.put(JSONObject().put("role", if(case.title) "TITLE" else "BODY").put("textSizePx",textSizePx)
                                    .put("text", renderedText).put("resolvedTypefaceIsDefault", actualFamily == defaultFamily)
                                    .put("actualLayoutStyle", inputStyle.toString()).put("samples",samples).put("characterBoxes",positions))
                            }
                            results.put(JSONObject().put("text", renderedText).put("inputText", case.text).put("role", if (case.title) "TITLE" else "BODY").put("widthDp", case.width).put("widthPx", widthPx).put("sizeSp", case.size).put("textSizePx", textSizePx).put("mode", case.mode.name)
                                .put("typefaceWeight", family.weight).put("density", density.density).put("fontScale", density.fontScale).put("lineHeightEm", preset.body.lineHeightEm).put("paintAscent", paint.fontMetricsInt.ascent).put("paintDescent", paint.fontMetricsInt.descent)
                                .put("composeEnds", JSONArray(composeEnds)).put("staticEnds", JSONArray(staticEnds)).put("staticMatchesCompose", composeEnds == staticEnds).put("lines", lines))
                            if (at + 1 == cases.size) {
                                File(output.parentFile, "reference-reader-fonts.json").writeText(JSONObject().put("complete",true).put("probes",fontProbes).toString())
                                output.writeText(JSONObject().put("complete", true).put("expectedCases", cases.size).put("cases", results).toString())
                            }
                            index = at + 1
                        }
                    }
                if (case.title) DetailTitle(title = case.text, titlePadding = 0.dp, textColor = Color.White, onTextLayout = capture)
                else DetailTextBlock(text = case.text, style = TextStyle.BODY, textColor = Color.White, fontSizeSp = case.size.sp, topPadding = 0.dp, isScrolling = false, onTextLayout = capture)
            }
        }
    }
}
