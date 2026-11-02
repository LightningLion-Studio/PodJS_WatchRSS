import android.os.SystemClock;
import java.lang.reflect.Method;
/** Shell-UID-only, task-scoped input driver. No app/account APIs. */
public final class DyPrepCadence {
 public static void main(String[] args)throws Exception {
  int count=Integer.parseInt(args[0]),pace=Integer.parseInt(args[1]);boolean prev=args[2].equals("prev");int duration=Integer.parseInt(args[3]);
  if(count<1||count>200||(pace!=200&&pace!=500&&pace!=1000)||duration<1||duration>=pace)throw new IllegalArgumentException();
  Method input=Class.forName("com.android.commands.input.Input").getMethod("main",String[].class);
  System.out.println("driver_pid="+android.os.Process.myPid());
  for(int i=0;i<count;i++){
   long start=SystemClock.uptimeMillis();
   input.invoke(null,(Object)new String[]{"swipe","233",prev?"220":"330","233",prev?"330":"220",Integer.toString(duration)});
   long end=SystemClock.uptimeMillis();
   System.out.println("trial="+i+" start_ms="+start+" end_ms="+end+" status=0");System.out.flush();
   if(i+1<count)SystemClock.sleep(Math.max(0,pace-(SystemClock.uptimeMillis()-start)));
  }
 }
}
