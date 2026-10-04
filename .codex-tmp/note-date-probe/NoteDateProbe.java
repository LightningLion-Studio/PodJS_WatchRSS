import android.text.format.DateUtils;
import java.util.Locale;
import java.util.TimeZone;
public class NoteDateProbe {
 public static void main(String[] args) {
  long now=System.currentTimeMillis();
  System.out.println("locale="+Locale.getDefault()+" timezone="+TimeZone.getDefault().getID()+" now="+now);
  long[] intervals={0,30000,59999,60000,3599999,3600000,86399999,86400000,172799999,172800000,259200000,518400000,604799999,604800000};
  for(long delta:intervals)System.out.println(delta+" past="+DateUtils.getRelativeTimeSpanString(now-delta,now,DateUtils.MINUTE_IN_MILLIS,DateUtils.FORMAT_ABBREV_RELATIVE)+" future="+DateUtils.getRelativeTimeSpanString(now+delta,now,DateUtils.MINUTE_IN_MILLIS,DateUtils.FORMAT_ABBREV_RELATIVE));
  if(args.length>0)System.out.println("note="+DateUtils.getRelativeTimeSpanString(Long.parseLong(args[0]),now,DateUtils.MINUTE_IN_MILLIS,DateUtils.FORMAT_ABBREV_RELATIVE));
 }
}
