// Public encryption key used by the self-hosted diagnostic log receiver.
export const LOG_UPLOAD_URL = "https://sly-data-plane.watchrss.cn/functions/v1/log-uploads";
export const LOG_CONSENT_VERSION = "log-upload-2026-11";
export const LOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArll0b+JkTEP1TR7Q0JMq
mVW6OjxRH+EE4jsiNB1F5wFMCckKWsfiKFxob45vC0RIl8mc3pfh6cxG+nVlAbss
8IV/QKAh0BCOy3AS7CfHuGC+gyMvLsGzR7SM3J/ofOdU0mzGGegZX3fjef4r8PuP
jAkdCGAEuhlQQtVzw91msVpXR1c3qTosErUSzwo2jlS4dQlLJOI7Z2viC4ihPoab
UzJ4nTZcDmM5/0aJ+ODrWHbUaTilhFF7Shr4TaIofKtaXMsmo8Bs+WN9kosIZbRG
WOvtLXLD/t7Y6jDVqAQap+vZjG86g8SEowTzOWnEEuQkkNceS1SU5XPkKaSPTZMn
RQIDAQAB
-----END PUBLIC KEY-----
`;

// Shared by the feedback logger and the pre-admission native uploader.
export const LOG_SENSITIVE_PATTERN = "access_token|api_key|apiKey|appRefreshToken|bili_jct|csrf_session_id|DedeUserID|DedeUserID__ckMd5|msToken|n_mh|odin_tt|passport_csrf_token|passport_csrf_token_default|refresh_token|refreshToken|SESSDATA|sessionid|sessionid_ss|sid|sid_guard|sid_tt|sid_ucp_v1|s_v_web_id|ssid_ucp_v1|ttwid|uid_tt|uid_tt_ss|watchrss_pair|[A-Za-z0-9_-]*token|password|secret|signature|sign|a_bogus|x_bogus|X-Bogus|w_rid";
export const LOG_HEADER_PATTERN = "(?:set-)?cookie|authorization|proxy-authorization|x-watchrss-pairing-auth";
