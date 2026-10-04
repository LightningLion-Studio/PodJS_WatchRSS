import com.lightningstudio.watchrss.ui.util.*;
public class WatchRssParserProbe {
 static String q(String s){if(s==null)return "null";return "\""+s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+"\"";}
 public static void main(String[] args){for(String raw:args){var blocks=RssContentParser.INSTANCE.parse(raw);var out=new java.util.ArrayList<String>();for(var b:blocks){if(b instanceof ContentBlock.Text t)out.add("{\"type\":\"text\",\"text\":"+q(t.getText())+",\"style\":"+q(t.getStyle().name().toLowerCase())+"}");else if(b instanceof ContentBlock.Image i)out.add("{\"type\":\"image\",\"url\":"+q(i.getUrl())+",\"alt\":"+q(i.getAlt())+",\"width\":"+i.getWidth()+",\"height\":"+i.getHeight()+"}");else if(b instanceof ContentBlock.Video v)out.add("{\"type\":\"video\",\"url\":"+q(v.getUrl())+",\"poster\":"+q(v.getPoster())+"}");}System.out.println("["+String.join(",",out)+"]");}}
}
