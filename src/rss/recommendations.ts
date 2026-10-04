// Source: Android_WatchRSS/data/rss/RssRecommendations.kt; kept in original order.
export interface RecommendedChannel { title: string; url: string }
export interface RecommendationGroup { id: string; name: string; description: string; channels: RecommendedChannel[] }
export const recommendationGroups: RecommendationGroup[] = [
  {
    "id": "bilibili",
    "name": "哔哩哔哩",
    "description": "进入后登录获取内容。",
    "channels": [
      {
        "title": "推荐入口",
        "url": "https://www.bilibili.com"
      }
    ]
  },
  {
    "id": "douyin",
    "name": "抖音",
    "description": "进入后登录获取内容。",
    "channels": [
      {
        "title": "推荐入口",
        "url": "https://www.douyin.com"
      }
    ]
  },
  {
    "id": "sspai",
    "name": "少数派",
    "description": "极客和数字生活爱好者的优质内容源。",
    "channels": [
      {
        "title": "RSS 地址",
        "url": "https://sspai.com/feed"
      }
    ]
  },
  {
    "id": "36kr",
    "name": "36氪",
    "description": "让一部分人先看到未来",
    "channels": [
      {
        "title": "综合资讯",
        "url": "https://36kr.com/feed"
      },
      {
        "title": "文章资讯",
        "url": "https://36kr.com/feed-article"
      },
      {
        "title": "最新快讯",
        "url": "https://36kr.com/feed-newsflash"
      },
      {
        "title": "动态内容",
        "url": "https://36kr.com/feed-moment"
      }
    ]
  },
  {
    "id": "huxiu",
    "name": "虎嗅",
    "description": "商业科技深度分析的好去处。",
    "channels": [
      {
        "title": "RSS 地址",
        "url": "https://rss.huxiu.com/"
      }
    ]
  },
  {
    "id": "chinanews",
    "name": "中国新闻网",
    "description": "权威新闻汇总，覆盖国内外要闻与专题栏目。",
    "channels": [
      {
        "title": "即时新闻",
        "url": "https://www.chinanews.com.cn/rss/scroll-news.xml"
      },
      {
        "title": "要闻导读",
        "url": "https://www.chinanews.com.cn/rss/importnews.xml"
      },
      {
        "title": "时政新闻",
        "url": "https://www.chinanews.com.cn/rss/china.xml"
      },
      {
        "title": "东西问",
        "url": "https://www.chinanews.com.cn/rss/dxw.xml"
      },
      {
        "title": "国际新闻",
        "url": "https://www.chinanews.com.cn/rss/world.xml"
      },
      {
        "title": "社会新闻",
        "url": "https://www.chinanews.com.cn/rss/society.xml"
      },
      {
        "title": "财经新闻",
        "url": "https://www.chinanews.com.cn/rss/finance.xml"
      },
      {
        "title": "健康·生活",
        "url": "https://www.chinanews.com.cn/rss/life.xml"
      },
      {
        "title": "大湾区",
        "url": "https://www.chinanews.com.cn/rss/dwq.xml"
      },
      {
        "title": "华人",
        "url": "https://www.chinanews.com.cn/rss/chinese.xml"
      },
      {
        "title": "文娱新闻",
        "url": "https://www.chinanews.com.cn/rss/culture.xml"
      },
      {
        "title": "体育新闻",
        "url": "https://www.chinanews.com.cn/rss/sports.xml"
      },
      {
        "title": "视频",
        "url": "https://www.chinanews.com.cn/rss/sp.xml"
      },
      {
        "title": "图片",
        "url": "https://www.chinanews.com.cn/rss/photo.xml"
      },
      {
        "title": "创意",
        "url": "https://www.chinanews.com.cn/rss/chuangyi.xml"
      },
      {
        "title": "直播",
        "url": "https://www.chinanews.com.cn/rss/zhibo.xml"
      }
    ]
  }
];
