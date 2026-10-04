package dev.podjs.androidwatch.reference

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LocalTextStyle
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontSynthesis
import androidx.compose.runtime.SideEffect
import android.graphics.Typeface
import android.graphics.Path
import android.graphics.RectF
import android.text.TextPaint
import org.json.JSONObject
import org.json.JSONArray
import com.lightningstudio.watchrss.ui.reader.readerTextStyle
import com.lightningstudio.watchrss.ui.reader.ReaderTextRole
import com.lightningstudio.watchrss.ui.viewmodel.LlmSummaryUiState
import com.lightningstudio.watchrss.ui.viewmodel.SummaryStatus
import com.lightningstudio.watchrss.ui.screen.rss.DetailContent
import com.lightningstudio.watchrss.data.rss.RssItem
import com.lightningstudio.watchrss.data.settings.RssInlineImagePrefetchMode
import com.lightningstudio.watchrss.ui.util.ContentBlock
import com.lightningstudio.watchrss.ui.util.TextStyle
import com.lightningstudio.watchrss.ui.screen.rss.ChannelSettingsScreen
import com.lightningstudio.watchrss.ui.screen.DeleteConfirmDialog
import android.os.Bundle
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import java.io.File
import java.io.FileOutputStream
import com.lightningstudio.watchrss.ui.screen.rss.ImagePreviewScreen
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.lightningstudio.watchrss.ui.screen.ActionDialogScreen
import com.lightningstudio.watchrss.ui.screen.ActionItem
import com.lightningstudio.watchrss.ui.theme.WatchRSSTheme
import com.lightningstudio.watchrss.ui.screen.rss.AutoScrollControlScreen

/** Uses production Compose surfaces in an isolated reference application. */
class ReferenceRssActivity : ComponentActivity() {
    private var usageDb: com.lightningstudio.watchrss.data.db.WatchRssDatabase? = null
    override fun onDestroy() { super.onDestroy(); usageDb?.close() }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
        if (intent.getBooleanExtra("reader-layout-probe", false)) {
            setContent { WatchRSSTheme { ReaderLineBreakProbe(File(getExternalFilesDir(null), "reference-reader-line-breaks.json")) } }
            return
        }
        if (intent.getBooleanExtra("search-screen", false)) {
            val results = listOf(
                RssItem(id = 1, channelId = 1, title = "同步验证：第一篇文章", description = "手机同步后保留收藏状态，正文可以离线阅读。",
                    content = "正文", originalContent = null, link = "https://example.test/first", pubDate = null,
                    imageUrl = null, audioUrl = null, videoUrl = null, summary = null, previewImageUrl = null,
                    isRead = false, isLiked = false, readingProgress = 0f, fetchedAt = 2),
                RssItem(id = 2, channelId = 1, title = "第二篇文章", description = "这段摘要说明同步进度和断线续传。",
                    content = "正文", originalContent = null, link = "https://example.test/second", pubDate = null,
                    imageUrl = null, audioUrl = null, videoUrl = null, summary = null, previewImageUrl = null,
                    isRead = false, isLiked = false, readingProgress = 0f, fetchedAt = 1)
            )
            setContent { WatchRSSTheme { com.lightningstudio.watchrss.ui.screen.rss.RssSearchScreen("同步", results, {}, {}) } }
            return
        }
        intent.getStringExtra("saved-list-mode")?.let { mode ->
            val sample = com.lightningstudio.watchrss.data.rss.SavedItem(
                item = RssItem(
                    id = 1, channelId = 1, title = "同步验证：第一篇文章",
                    description = "手机同步后保留收藏状态，正文可以离线阅读。",
                    content = "正文", originalContent = null, link = "https://example.test/first",
                    pubDate = null, imageUrl = null, audioUrl = null, videoUrl = null,
                    summary = "正文可以离线阅读。", previewImageUrl = null,
                    isRead = false, isLiked = false, readingProgress = 0f, fetchedAt = 1790280000000
                ),
                channelTitle = "科技频道", savedAt = 1790280000000,
                saveType = com.lightningstudio.watchrss.data.rss.SaveType.FAVORITE
            )
            setContent { WatchRSSTheme {
                com.lightningstudio.watchrss.ui.screen.rss.SavedItemsScreen(
                    title = "我的收藏", hint = "保存在本地，离线可读，长按可拖动排序",
                    emptyMessage = "暂无收藏", hasLoadedItems = true,
                    items = if (mode == "empty") emptyList() else listOf(sample),
                    undoVisible = false, onUndoClick = {}, onItemClick = {},
                    onItemRemove = {}, onItemsReordered = {}, syncOperationLabel = "同步收藏"
                )
            } }
            return
        }
        if (intent.getBooleanExtra("add-rss-input", false)) {
            val mode = intent.getStringExtra("add-rss-mode") ?: "input"
            val state = kotlinx.coroutines.flow.MutableStateFlow(
                when (mode) {
                    "empty" -> com.lightningstudio.watchrss.ui.viewmodel.AddRssUiState()
                    "error" -> com.lightningstudio.watchrss.ui.viewmodel.AddRssUiState(
                        url = "https://example.com/feed.xml", errorMessage = "解析失败"
                    )
                    "preview" -> com.lightningstudio.watchrss.ui.viewmodel.AddRssUiState(
                        step = com.lightningstudio.watchrss.ui.viewmodel.AddRssStep.PREVIEW,
                        preview = com.lightningstudio.watchrss.data.rss.RssChannelPreview(
                            url = "https://example.com/feed.xml", title = "示例频道", description = "每天更新的技术文章", imageUrl = null, siteUrl = null, items = emptyList(), isBuiltin = false
                        )
                    )
                    "existing" -> com.lightningstudio.watchrss.ui.viewmodel.AddRssUiState(
                        step = com.lightningstudio.watchrss.ui.viewmodel.AddRssStep.EXISTING,
                        existingChannel = com.lightningstudio.watchrss.data.rss.RssChannel(
                            id = 1, url = "https://example.com/feed.xml", title = "示例频道", description = null,
                            imageUrl = null, lastFetchedAt = null, sortOrder = 0, isPinned = false,
                            useOriginalContent = false, unreadCount = 0
                        )
                    )
                    else -> com.lightningstudio.watchrss.ui.viewmodel.AddRssUiState(url = "https://example.com/feed.xml")
                }
            )
            setContent { WatchRSSTheme {
                com.lightningstudio.watchrss.ui.screen.rss.AddRssScreen(
                    uiState = state,
                    onUrlChange = {}, onSubmit = {}, onConfirm = {}, onBack = {},
                    onBackToInput = {}, onOpenExisting = {}, onChannelAdded = { _, _ -> },
                    onConsumed = {}, onClearError = {}
                )
            } }
            return
        }
        intent.getStringExtra("speech-playback")?.let { mode ->
            setContent { WatchRSSTheme {
              androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.fillMaxSize()) {
                com.lightningstudio.watchrss.ui.screen.rss.ReadAloudPlaybackScreen(
                    state = com.lightningstudio.watchrss.data.tts.ReadAloudUiState(
                        visible = true,
                        phase = if (mode == "error") com.lightningstudio.watchrss.data.tts.ReadAloudPhase.ERROR else com.lightningstudio.watchrss.data.tts.ReadAloudPhase.READY,
                        currentItemId = 1, currentTitle = "朗读验证第一篇", queueIndex = 1, queueSize = 2,
                        isPlaying = mode == "playing" || mode == "volume", segmentIndex = 1, segmentCount = 2,
                        autoAdvanceEnabled = mode != "auto-off", speechRate = if (mode == "auto-off") 1.15f else 1f,
                        errorMessage = if (mode == "error") "朗读引擎未能完成当前段落" else null
                    ),
                    onTogglePlayPause = {}, onPrevious = {}, onNext = {}, onStop = {}, onToggleAutoAdvance = {},
                    onDecreaseSpeechRate = {}, onIncreaseSpeechRate = {}, digitalCrownVolumeEnabled = false,
                    currentArticleActionText = "返回文章", onOpenCurrentArticle = {}
                )
                if (mode == "volume") ReferenceVolumeOverlay(androidx.compose.ui.Modifier.align(androidx.compose.ui.Alignment.Center))
              }
            } }
            return
        }
        val previewFile = intent.getStringExtra("image-preview-path")?.let(::File) ?: File(filesDir, "image-preview-fixture.png")
        if (intent.getBooleanExtra("image-preview", false) && intent.getStringExtra("image-preview-path") == null) {
            val bitmap = Bitmap.createBitmap(120, 60, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(0xff28a75b.toInt())
            Canvas(bitmap).drawRect(0f, 0f, 12f, 60f, Paint().apply { color = 0xffd83c3c.toInt() })
            FileOutputStream(previewFile).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        val aiMode = intent.getStringExtra("ai-mode")
        val usageModel = if (aiMode?.startsWith("usage") == true) {
            val db = androidx.room.Room.inMemoryDatabaseBuilder(this, com.lightningstudio.watchrss.data.db.WatchRssDatabase::class.java).allowMainThreadQueries().build()
            usageDb = db
            if (aiMode == "usage") kotlinx.coroutines.runBlocking {
                val day = (System.currentTimeMillis() / 86400000L) * 86400000L
                for (i in 0..2) db.llmTokenUsageDao().insert(com.lightningstudio.watchrss.data.db.LlmTokenUsageEntity(
                    provider = "WatchRSS", model = if (i == 0) "fixture-a" else "fixture-b", requestId = "usage-fixture-$i",
                    promptTokens = (i + 1) * 12, completionTokens = (i + 1) * 4, totalTokens = (i + 1) * 16,
                    reasoningTokens = null, cachedPromptTokens = null, inputTokens = null, outputTokens = null,
                    promptTokenCount = null, candidatesTokenCount = null, totalTokenCount = null, createdAt = day - i * 86400000L
                ))
            }
            val factory = object: androidx.lifecycle.ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST") override fun <T: androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                    com.lightningstudio.watchrss.ui.viewmodel.LlmTokenUsageViewModel(com.lightningstudio.watchrss.data.llm.LlmTokenUsageRepository(db.llmTokenUsageDao())) as T
            }
            androidx.lifecycle.ViewModelProvider(this, factory)[com.lightningstudio.watchrss.ui.viewmodel.LlmTokenUsageViewModel::class.java]
        } else null
        setContent {
            WatchRSSTheme {
                val channelMode = intent.getStringExtra("channel-mode")
                val readerMode = intent.getStringExtra("reader-mode")
                if (aiMode == "preset") {
                    val preset = androidx.compose.runtime.remember { androidx.compose.runtime.mutableIntStateOf(1) }
                    com.lightningstudio.watchrss.ui.screen.rss.LlmPromptPresetScreen(preset.intValue) { preset.intValue = it }
                } else if (usageModel != null) {
                    com.lightningstudio.watchrss.ui.screen.rss.LlmTokenUsageScreen(usageModel) { finish() }
                } else if (readerMode != null) {
                    val titleStyle = readerTextStyle(ReaderTextRole.TITLE)
                    val resolvedFont = LocalFontFamilyResolver.current.resolve(titleStyle.fontFamily,
                        titleStyle.fontWeight ?: FontWeight.Normal, titleStyle.fontStyle ?: FontStyle.Normal,
                        titleStyle.fontSynthesis ?: FontSynthesis.All).value as Typeface
                    SideEffect {
                        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = resolvedFont; textSize = 43.4f }
                        val path = Path(); paint.getTextPath("原", 0, 1, 0f, 0f, path)
                        val bounds = RectF(); path.computeBounds(bounds, true)
                        val metrics = paint.fontMetrics
                        val data = JSONObject().put("styleSource", "explicit readerTextStyle, without inherited theme family").put("requestedWeight", titleStyle.fontWeight?.weight)
                            .put("resolvedWeight", resolvedFont.weight).put("bold", resolvedFont.isBold)
                            .put("titleAdvance", paint.measureText("原文验证文章"))
                            .put("ascent", metrics.ascent).put("descent", metrics.descent)
                            .put("originalGlyphBounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
                        File(getExternalFilesDir(null), "reference-reader-font.json").writeText(data.toString(2))
                    }
                    val title = if (readerMode.startsWith("highlight")) "朗读高亮验证标题" else if (readerMode == "long") "自动滚动验证文章" else "原文验证文章"
                    val body = if (readerMode == "emoji") "汉😀导入正文。\n组合：👩‍💻 🇨🇳 👍🏽" else if (readerMode.startsWith("highlight")) (0 until 40).joinToString("") { "第${it}句正文甲乙丙丁戊己庚辛壬癸。" } else if (readerMode == "long") (0 until 120).joinToString("\n") { "第${it}段，自动滚动与阅读位置测试。" } else "RSS保留摘要"
                    val article = RssItem(id = 1, channelId = 1, title = title,
                        description = body, content = body, originalContent = null,
                        link = "https://example.test/reference-reader", pubDate = null,
                        imageUrl = null, audioUrl = null, videoUrl = null, summary = null,
                        previewImageUrl = null, isRead = true, isLiked = true,
                        readingProgress = 0f, fetchedAt = 1)
                    DetailContent(item = article, showOriginalLoadingNotice = false,
                        llmSummaryState = when (readerMode) {
                            "summary-error" -> LlmSummaryUiState(itemId = 1, status = SummaryStatus.Error("请先从已授权手机同步账号"))
                            "summary-done" -> LlmSummaryUiState(itemId = 1, status = SummaryStatus.Done, text = "AI验证总结：已读取缓存原文。", promptTokens = 12, completionTokens = 4, totalTokens = 16)
                            else -> LlmSummaryUiState()
                        },
                        readAloudState = if (readerMode.startsWith("highlight")) com.lightningstudio.watchrss.data.tts.ReadAloudUiState(
                            visible = true, phase = com.lightningstudio.watchrss.data.tts.ReadAloudPhase.READY,
                            currentItemId = 1, currentTitle = title, isPlaying = true, queueIndex = 1, queueSize = 1,
                            segmentIndex = if (readerMode == "highlight-title") 1 else 2, segmentCount = 4,
                            highlightRange = com.lightningstudio.watchrss.data.tts.ReadAloudHighlightRange(
                                itemId = 1, segmentIndex = if (readerMode == "highlight-title") 1 else 2,
                                segmentText = if (readerMode == "highlight-title") "$title。" else com.lightningstudio.watchrss.data.tts.ReadAloudTextSegmenter.segment(body, 240).first(),
                                rangeStart = if (readerMode == "highlight-title") 2 else 150,
                                rangeEnd = if (readerMode == "highlight-title") 5 else 156,
                                contentBlockIndex = if (readerMode == "highlight-title") null else 0,
                                contentCharOffset = if (readerMode == "highlight-title") 2 else 142,
                                contentCharEndOffset = if (readerMode == "highlight-title") 5 else 147,
                                isFallback = false, useOriginalContent = false, isTitle = readerMode == "highlight-title"
                            )
                        ) else com.lightningstudio.watchrss.data.tts.ReadAloudUiState(),
                        contentBlocks = listOf(ContentBlock.Text(body, TextStyle.BODY)),
                        offlineMedia = emptyMap(), hasOfflineFailures = false, isRetryingOfflineMedia = false,
                        isFavorite = true, isWatchLater = false, originalContentEnabled = false,
                        readingFontSizeSp = 14, shareUseSystem = false,
                        rssInlineImagePrefetchMode = RssInlineImagePrefetchMode.FIRST_FEW,
                        onToggleFavorite = {}, onToggleOriginalContent = {}, onRetryOfflineMedia = {},
                        onSaveReadingProgress = {}, onBack = { _, _, _ -> })
                } else if (channelMode == "delete" || channelMode == "clear") {
                    DeleteConfirmDialog(
                        title = if (channelMode == "clear") "清空内容" else "删除频道",
                        message = if (channelMode == "clear") "清空后将移除这个频道内的本地条目" else "删除后将移除本地缓存",
                        onConfirm = {}, onCancel = {})
                } else if (channelMode != null) {
                    ChannelSettingsScreen(showOriginalContent = true, originalContentEnabled = channelMode != "media",
                        onToggleOriginalContent = {}, showContinuePlaybackInBackground = channelMode == "media",
                        continuePlaybackInBackgroundEnabled = true, onToggleContinuePlaybackInBackground = {},
                        clearEnabled = channelMode == "local", onClear = {}, deleteEnabled = true, onDelete = {})
                } else if (intent.getBooleanExtra("image-preview", false)) {
                    ImagePreviewScreen(url=previewFile.absolutePath, alt="验证图片")
                } else if (intent.getBooleanExtra("auto-scroll", false)) {
                    AutoScrollControlScreen(autoStartEnabled=false, linesPerSecond=2f,
                        readerSessionActive=true, isPlaying=true, onPlayingChange={},
                        onAutoStartEnabledChange={}, onLinesPerSecondChange={}, onReturnToArticle={})
                } else ActionDialogScreen(items = listOf(
                    ActionItem("取消收藏", onClick = {}),
                    ActionItem("稍后再看", onClick = {}),
                    ActionItem("分享", onClick = {}),
                    ActionItem("取消", onClick = {})
                ), extraTopPadding = 4.dp)
            }
        }
    }
}


/** Fixed presentation state only: does not call adjustByDelta or write AudioManager. */
@androidx.compose.runtime.Composable
private fun ReferenceVolumeOverlay(modifier: androidx.compose.ui.Modifier) {
    val state = com.lightningstudio.watchrss.ui.components.rememberPlayerVolumeState(false, null)
    val context = androidx.compose.ui.platform.LocalContext.current
    val manager = context.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
    androidx.compose.runtime.SideEffect {
        val min = manager.getStreamMinVolume(android.media.AudioManager.STREAM_MUSIC)
        val max = manager.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC)
        val virtual = state.javaClass.getDeclaredField("virtualVolume\$delegate").apply { isAccessible = true }.get(state) as androidx.compose.runtime.MutableFloatState
        virtual.floatValue = min + (max - min) * .21f
        @Suppress("UNCHECKED_CAST")
        val visible = state.javaClass.getDeclaredField("isVisible\$delegate").apply { isAccessible = true }.get(state) as androidx.compose.runtime.MutableState<Boolean>
        visible.value = true
    }
    com.lightningstudio.watchrss.ui.components.PlayerVolumeOverlay(state, modifier)
}
