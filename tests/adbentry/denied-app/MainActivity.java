package dev.podjs.adbentry.denied;
import android.app.Activity;
import android.os.Bundle;
import android.net.Uri;
public final class MainActivity extends Activity {
 @Override public void onCreate(Bundle saved){super.onCreate(saved);
  int denied=0,unexpected=0;
  for(String command:new String[]{"douyin.state","not.aCommand","diag.dump"})try{
   getContentResolver().call(Uri.parse("content://com.lightningstudio.watchrss.adbentry.podjs.shell"),command,command.equals("diag.dump")?"malformed":"{}",null);
   unexpected++;
  }catch(SecurityException error){if("denied".equals(error.getMessage()))denied++;else unexpected++;}
  catch(Exception error){unexpected++;}
  android.util.Log.i("ADBENTRY_CLIENT","uid="+android.os.Process.myUid()+" denied="+denied+" unexpected="+unexpected);
  finish();
 }
}
