# Host-only reference parser. Each source is parsed independently, including EOF.
import ctypes, ctypes.util, json, sys
cmark=ctypes.CDLL(ctypes.util.find_library('cmark'))
cmark.cmark_markdown_to_html.argtypes=[ctypes.c_char_p,ctypes.c_size_t,ctypes.c_int]
cmark.cmark_markdown_to_html.restype=ctypes.c_void_p
libc=ctypes.CDLL(ctypes.util.find_library('c'))
libc.free.argtypes=[ctypes.c_void_p]
result=[]
for source in json.load(sys.stdin):
    data=source.encode('utf-8')
    pointer=cmark.cmark_markdown_to_html(data,len(data),1 << 17) # CMARK_OPT_UNSAFE: retain HTML for inert oracle parsing.
    if not pointer: raise RuntimeError('cmark allocation failed')
    try: result.append(ctypes.string_at(pointer).decode('utf-8'))
    finally: libc.free(pointer)
json.dump(result,sys.stdout,ensure_ascii=False)
