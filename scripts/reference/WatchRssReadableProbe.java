import com.lightningstudio.watchrss.data.rss.RssReadableService;
public class WatchRssReadableProbe {
 public static void main(String[] args)throws Exception{
  var service=new RssReadableService();
  var method=RssReadableService.class.getDeclaredMethod("extractReadableHtml",String.class,String.class);method.setAccessible(true);
  for(String html:args){String result=(String)method.invoke(service,html,"https://example.test/news/item");System.out.println(WatchRssParserProbe.q(result));}
 }
}
