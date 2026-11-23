use crate::update_protocol::Policy;
use std::sync::atomic::{AtomicBool,Ordering};

#[cfg(windows)]
pub fn stream(url: &str,policy: &Policy,limit: u64,cancel: &AtomicBool,mut receive: impl FnMut(&[u8]) -> Result<(),String>) -> Result<(u32,u64),String> {
    use windows_sys::Win32::Networking::WinHttp::*;
    use std::{ffi::c_void,ptr::{null,null_mut},time::{Duration,Instant}};
    struct Handle(*mut c_void);
    impl Drop for Handle { fn drop(&mut self) { unsafe { WinHttpCloseHandle(self.0); } } }
    fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
    fn check(ok: i32) -> Result<(),String> { if ok == 0 { Err(std::io::Error::last_os_error().to_string()) } else { Ok(()) } }
    fn handle(pointer: *mut c_void) -> Result<Handle,String> { if pointer.is_null() { Err(std::io::Error::last_os_error().to_string()) } else { Ok(Handle(pointer)) } }
    fn header(request: &Handle,key: u32) -> Result<String,String> {
        let mut length = 8192u32; let mut words = vec![0u16;4096];
        check(unsafe { WinHttpQueryHeaders(request.0,key,null(),words.as_mut_ptr().cast(),&mut length,null_mut()) })?;
        words.truncate(length as usize / 2);
        if words.last() == Some(&0) { words.pop(); }
        String::from_utf16(&words).map_err(|e| e.to_string())
    }
    let started = Instant::now();
    let agent = wide(concat!("lolPing-Desktop-Pilot/",env!("LOLPING_APP_VERSION")));
    let proxy = if policy.test_origin.is_some() { WINHTTP_ACCESS_TYPE_NO_PROXY } else { WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY };
    let session = handle(unsafe { WinHttpOpen(agent.as_ptr(),proxy,null(),null(),0) })?;
    let protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
    check(unsafe { WinHttpSetOption(session.0,WINHTTP_OPTION_SECURE_PROTOCOLS,(&protocols as *const u32).cast(),4) })?;
    check(unsafe { WinHttpSetTimeouts(session.0,5000,5000,15000,15000) })?;
    let mut address = url.to_owned();
    for _ in 0..5 {
        if cancel.load(Ordering::SeqCst) { return Err("Update canceled".into()); }
        if !policy.allowed(&address) { return Err("Update URL is outside the allowed release hosts".into()); }
        let parsed = url::Url::parse(&address).map_err(|e| e.to_string())?;
        let host = wide(parsed.host_str().ok_or("Update URL has no host")?);
        let connect = handle(unsafe { WinHttpConnect(session.0,host.as_ptr(),parsed.port_or_known_default().ok_or("Invalid update port")?,0) })?;
        let mut path = parsed.path().to_owned(); if let Some(query) = parsed.query() { path.push('?'); path.push_str(query); }
        let path = wide(&path); let verb = wide("GET");
        let request = handle(unsafe { WinHttpOpenRequest(connect.0,verb.as_ptr(),path.as_ptr(),null(),null(),null(),if parsed.scheme() == "https" {WINHTTP_FLAG_SECURE} else {0}) })?;
        let redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        check(unsafe { WinHttpSetOption(request.0,WINHTTP_OPTION_REDIRECT_POLICY,(&redirect as *const u32).cast(),4) })?;
        let accept = if parsed.path().ends_with("/releases/latest") { "application/vnd.github+json" } else { "application/octet-stream" };
        let headers = wide(&format!("Accept: {accept}\r\nX-GitHub-Api-Version: 2022-11-28\r\n"));
        check(unsafe { WinHttpSendRequest(request.0,headers.as_ptr(),headers.len() as u32 - 1,null(),0,0,0) })?;
        check(unsafe { WinHttpReceiveResponse(request.0,null_mut()) })?;
        let mut status = 0u32; let mut size = 4;
        check(unsafe { WinHttpQueryHeaders(request.0,WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,null(),(&mut status as *mut u32).cast(),&mut size,null_mut()) })?;
        if [301,302,303,307,308].contains(&status) {
            let location = header(&request,WINHTTP_QUERY_LOCATION)?;
            address = parsed.join(&location).map_err(|e| e.to_string())?.to_string(); continue;
        }
        if status != 200 { return Ok((status,0)); }
        if let Ok(length) = header(&request,WINHTTP_QUERY_CONTENT_LENGTH) {
            if length.parse::<u64>().is_ok_and(|n| n > limit) { return Err("Update response exceeds its size limit".into()); }
        }
        let mut count = 0u64; let mut buffer = vec![0u8;65536];
        loop {
            if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(300) { return Err("Update canceled or timed out".into()); }
            let mut read = 0;
            check(unsafe { WinHttpReadData(request.0,buffer.as_mut_ptr().cast(),buffer.len() as u32,&mut read) })?;
            if read == 0 { return Ok((status,count)); }
            count = count.saturating_add(read as u64);
            if count > limit { return Err("Update response exceeds its size limit".into()); }
            receive(&buffer[..read as usize])?;
        }
    }
    Err("Too many update redirects".into())
}

#[cfg(not(windows))]
pub fn stream(_: &str,_: &Policy,_: u64,_: &AtomicBool,_: impl FnMut(&[u8]) -> Result<(),String>) -> Result<(u32,u64),String> {
    Err("Native update transport is only available on Windows".into())
}
