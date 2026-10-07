package dev.podjs.takeover

import android.database.sqlite.SQLiteDatabase
import java.util.Properties
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.lightningstudio.watchrss.WatchRssApplication
import com.lightningstudio.watchrss.data.db.WatchRssDatabase
import com.lightningstudio.watchrss.data.db.OfflineMediaEntity
import com.lightningstudio.watchrss.data.reader.*
import com.lightningstudio.watchrss.data.rss.DefaultRssRepository
import com.lightningstudio.watchrss.data.settings.CURRENT_OOBE_VERSION
import com.lightningstudio.watchrss.data.settings.PRIVACY_POLICY_VERSION
import com.lightningstudio.watchrss.testutil.RealDataTestHelper
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/** T6 instrumentation only: synthetic data in the explicitly isolated package. */
class T6BusinessTest {
    private val c get() = InstrumentationRegistry.getInstrumentation().targetContext.also {
        check(it.packageName == "com.lightningstudio.watchrss.podjs.rehearsal")
        check(it.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
    }
    private val app get() = c.applicationContext as WatchRssApplication
    private val container get() = app.container
    private fun database(): WatchRssDatabase {
        val preset = container.readerPresetRepository
        return preset.javaClass.getDeclaredField("database").apply { isAccessible=true }.get(preset) as WatchRssDatabase
    }
    private fun report(stage: String) = InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
        putString("stage",stage); putBoolean("businessMatches",true); putBoolean("workManagerAvailable",true)
        putInt("channels",3); putInt("articles",3)
    })
    @Test fun seedBusiness40() = runBlocking {
        check(c.packageManager.getPackageInfo(c.packageName,0).longVersionCode==40L)
        val marker=File(c.applicationInfo.dataDir,"recovery-rehearsal/business.json");check(!marker.exists())
        RealDataTestHelper.clearTestData()
        val rss=container.rssRepository as DefaultRssRepository
        for (i in 1..3) {
            val channel=rss.testChannelDao.insertChannel(RealDataTestHelper.sampleChannel(
                url="https://rehearsal.invalid/feed$i",title="T6 Synthetic $i",isPinned=i==3))
            rss.testItemDao.insertItems(listOf(RealDataTestHelper.sampleItem(channelId=channel,
                title="T6 Article $i",dedupKey="t6-$i",isRead=i==2).copy(
                link="https://rehearsal.invalid/article$i",readingProgress=if(i==2)0.5f else 0f)))
        }
        container.settingsRepository.setOobeSeenVersion(CURRENT_OOBE_VERSION)
        container.settingsRepository.setPrivacyPolicyAgreedVersion(PRIVACY_POLICY_VERSION)
        container.settingsRepository.setPhoneConnectionEnabled(false)
        container.settingsRepository.setReadingThemeDark(true)
        container.settingsRepository.setReadingFontSizeSp(18)
        val note=container.watchNoteRepository.saveRawMarkdown(null,"# T6 native synthetic note\nrestore baseline", "t6-synthetic",now=1700000000000L)
        container.readerPresetRepository.ensureSeeded(true,18)
        val db=database()
        val image=File(c.filesDir,"offline/rss/t6/t6.png");image.parentFile!!.mkdirs()
        FileOutputStream(image).use { Bitmap.createBitmap(32,32,Bitmap.Config.ARGB_8888).apply {eraseColor(Color.rgb(32,64,96))}.compress(Bitmap.CompressFormat.PNG,100,it);it.fd.sync() }
        val resources=container.readerPresetRepository.resourceStore
        val font=resources.targetFontFile("t6-system.ttf")
        val sourceFont=File("/system/fonts").listFiles()!!.sortedBy { it.name }.first { it.isFile && it.extension=="ttf" }
        sourceFont.copyTo(font,overwrite=false)
        val background=resources.targetBackgroundFile("t6.png");image.copyTo(background,overwrite=false)
        db.readerPresetDao().upsertFont(ReaderFontAssetEntity("t6-font",NativeBackup.hash(font),"T6 system font","T6","t6-system.ttf","font/ttf",font.length(),1,"{}",1700000000000L,"t6-synthetic",false))
        db.readerPresetDao().upsertBackground(ReaderBackgroundAssetEntity("t6-bg",NativeBackup.hash(background),"T6 synthetic background","IMAGE","image/png","t6.png",background.length(),0L,32,32,null,"{}",1700000000000L,"t6-synthetic",false))
        container.readerPresetRepository.savePreset(ReaderPreset(name="T6 synthetic reader",body=ReaderTextStyle(fontAssetId="t6-font"),background=ReaderBackground(type=ReaderBackgroundType.IMAGE,assetId="t6-bg")))
        val item=rss.testItemDao.observeItemsPaged(rss.testChannelDao.observeChannels().first().first().id, 10).first().first()
        db.offlineMediaDao().insertAll(listOf(OfflineMediaEntity(itemId=item.id,mediaType="IMAGE",originUrl="https://rehearsal.invalid/t6.png",localPath=image.absolutePath,createdAt=1700000000000L)))
        for (path in listOf(File(c.applicationInfo.dataDir,"recovery-rehearsal/empty"),File(c.noBackupFilesDir,"t6-empty"))) check(path.mkdirs()||path.isDirectory)
        File(c.noBackupFilesDir,"t6-synthetic.txt").writeText("T6 synthetic no_backup\n")
        // Real bytes (not a sparse file) keep restore copy observable for a force-stop.
        FileOutputStream(File(c.filesDir,"offline/rss/t6/interrupt.bin")).use { out ->
            val block=ByteArray(1024*1024) { (it%251).toByte() };repeat(64){out.write(block)};out.fd.sync()
        }
        val wm=WorkManager.getInstance(c)
        val work=wm.getWorkInfosForUniqueWork("watchrss-watch-cloud-sync-6h").get(30,TimeUnit.SECONDS)
        assertEquals(1,work.size)
        marker.writeText(JSONObject().put("noteId",note.noteId).put("workId",work.single().id.toString()).toString())
        assertEquals(3,rss.testChannelDao.observeChannels().first().size)
        report("business40")
    }
    @Test fun verifyBusiness900000() = runBlocking {
        check(c.packageManager.getPackageInfo(c.packageName,0).longVersionCode==900000L)
        val marker=JSONObject(File(c.applicationInfo.dataDir,"recovery-rehearsal/business.json").readText())
        val rss=container.rssRepository as DefaultRssRepository
        assertEquals(3,rss.testChannelDao.observeChannels().first().size)
        assertEquals(1,container.watchNoteRepository.all().count { it.noteId==marker.getString("noteId") && it.markdown=="# T6 native synthetic note\nrestore baseline" })
        assertEquals(18,container.settingsRepository.readingFontSizeSp.first())
        assertTrue(File(c.filesDir,"offline/rss/t6/t6.png").isFile)
        val db=database()
        assertEquals(1,db.readerPresetDao().allFontRecords().count { it.id=="t6-font" })
        assertEquals(1,db.readerPresetDao().allBackgroundRecords().count { it.id=="t6-bg" })
        assertTrue(container.readerPresetRepository.resourceStore.targetFontFile("t6-system.ttf").isFile)
        assertTrue(container.readerPresetRepository.resourceStore.targetBackgroundFile("t6.png").isFile)
        assertEquals(64L*1024*1024,File(c.filesDir,"offline/rss/t6/interrupt.bin").length())
        assertTrue(File(c.applicationInfo.dataDir,"recovery-rehearsal/empty").isDirectory)
        assertTrue(File(c.noBackupFilesDir,"t6-empty").isDirectory)
        val work=WorkManager.getInstance(c).getWorkInfosForUniqueWork("watchrss-watch-cloud-sync-6h").get(30,TimeUnit.SECONDS)
        assertEquals(1,work.size);assertEquals(marker.getString("workId"),work.single().id.toString())
        assertTrue(WorkManager.getInstance(c).getWorkInfosForUniqueWork("podjs-cloud-sync-6h").get(30,TimeUnit.SECONDS).isEmpty())
        val last=Properties().apply { File(c.filesDir,".podjs-recovery-state/last").inputStream().use {load(it)} }
        val g=last.getProperty("generation");check(g.matches(Regex("g-[A-Za-z0-9-]+")))
        val complete=Properties().apply {File(c.filesDir,".podjs-recovery-state/$g/complete").inputStream().use {load(it)}}
        assertEquals(NativeBackup(File(c.applicationInfo.dataDir)).verify(g),complete.getProperty("sha256"))
        assertTrue(File(c.filesDir,".podjs-recovery-state/$g/workmanager-jobs-retired").readBytes().contentEquals(byteArrayOf(49,10)))
        val archive=File(c.filesDir,".podjs-recovered/$g/files/package-takeover/generations/$g/podjs.sqlite")
        SQLiteDatabase.openDatabase(archive.path,null,SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT COUNT(*) FROM memo_notes WHERE note_id='t6-podjs-note' AND markdown=?",arrayOf("# T6 PodJS synthetic note\narchive after recovery")).use { row ->assertTrue(row.moveToFirst());assertEquals(1,row.getInt(0))}
        }
        report("business900000")
    }
    @Test fun writePostRecoveryNote900000() = runBlocking {
        check(c.packageManager.getPackageInfo(c.packageName,0).longVersionCode==900000L)
        val marker=File(c.applicationInfo.dataDir,"recovery-rehearsal/after-recovery.json");check(!marker.exists())
        val note=container.watchNoteRepository.saveRawMarkdown(null,"T6 after recovery survives second start", "t6-synthetic")
        marker.writeText(JSONObject().put("noteId",note.noteId).toString());report("native-new-note")
    }
    @Test fun verifySecondNativeStart900000() = runBlocking {
        check(c.packageManager.getPackageInfo(c.packageName,0).longVersionCode==900000L)
        val marker=JSONObject(File(c.applicationInfo.dataDir,"recovery-rehearsal/after-recovery.json").readText())
        assertEquals(1,container.watchNoteRepository.all().count {it.noteId==marker.getString("noteId") && it.markdown=="T6 after recovery survives second start"})
        report("native-second-start")
    }
}
