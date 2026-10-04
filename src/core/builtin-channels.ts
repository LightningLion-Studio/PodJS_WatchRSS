export const BUILTIN_CHANNELS = [
  {url:'builtin:bili',title:'哔哩哔哩',description:'进入后登录获取推荐内容'},
  {url:'builtin:douyin',title:'抖音',description:'进入后登录获取推荐内容'},
] as const;

export type BuiltinChannel = typeof BUILTIN_CHANNELS[number];

/** Match the native BuiltinChannelType.fromHost rule for add-by-URL. */
export function builtinForInput(value:string,host:string|null):BuiltinChannel|undefined {
  const direct=BUILTIN_CHANNELS.find(channel=>channel.url===value);
  if(direct)return direct;
  const normalized=host?.toLowerCase();
  if(normalized?.endsWith('bilibili.com'))return BUILTIN_CHANNELS[0];
  if(normalized?.endsWith('douyin.com'))return BUILTIN_CHANNELS[1];
  return undefined;
}
