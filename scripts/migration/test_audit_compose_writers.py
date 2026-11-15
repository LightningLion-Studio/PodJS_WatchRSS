import unittest
from audit_compose_writers import scan
class PublishedWriterScanTest(unittest.TestCase):
 def test_multiline_encrypted_name_and_comment_exclusion(self):
  source='const val PREFS_FILE = "read_aloud_secure_prefs"\n// getSharedPreferences("fake", 0)\nEncryptedSharedPreferences.create(\n context, PREFS_FILE, masterKey, keyScheme, valueScheme\n)'
  rows=scan('app/src/main/Old.kt',source)
  self.assertEqual(len(rows),1);self.assertEqual(rows[0]['names'],['read_aloud_secure_prefs']);self.assertEqual(rows[0]['line'],3)
 def test_datastore_suffix_and_file_write_receiver(self):
  rows=scan('app/src/main/Store.kt','val file = File(context.filesDir, "article_content")\nfile.writeBytes(bytes)\ncontext.preferencesDataStoreFile("settings.preferences_pb")')
  self.assertEqual(rows[1]['names'],['files/article_content']);self.assertEqual(rows[2]['names'],['settings.preferences_pb'])
 def test_unresolved_preference_cannot_pass(self):
  self.assertEqual(scan('app/src/main/Store.kt','context.getSharedPreferences(futureName(), 0)')[0]['resolution'],'UNRESOLVED')
if __name__=='__main__':unittest.main()
