#[cfg(windows)]
pub fn read() -> Option<String> {
    use windows_sys::Win32::System::{DataExchange::*, Memory::*};
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 { return None; }
        let result = (|| {
            let data = GetClipboardData(13);
            if data.is_null() { return None; }
            let size = GlobalSize(data);
            if size == 0 || size > 16_384 { return None; }
            let pointer = GlobalLock(data);
            if pointer.is_null() { return None; }
            let words = std::slice::from_raw_parts(pointer.cast::<u16>(), (size / 2).min(2000));
            let length = words.iter().position(|&c| c == 0).unwrap_or(words.len());
            let text = String::from_utf16_lossy(&words[..length]);
            GlobalUnlock(data);
            Some(text)
        })();
        CloseClipboard(); result
    }
}

#[cfg(windows)]
pub fn write(window: &tauri::WebviewWindow, text: &str) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::GlobalFree, System::{DataExchange::*, Memory::*}};
    let words: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let owner = window.hwnd().map_err(|e| e.to_string())?.0;
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, words.len() * 2);
        if memory.is_null() { return Err("Cannot allocate clipboard text".into()); }
        let pointer = GlobalLock(memory);
        if pointer.is_null() { GlobalFree(memory); return Err("Cannot lock clipboard text".into()); }
        std::ptr::copy_nonoverlapping(words.as_ptr(), pointer.cast::<u16>(), words.len());
        GlobalUnlock(memory);
        if OpenClipboard(owner) == 0 { GlobalFree(memory); return Err("Clipboard is busy".into()); }
        let success = EmptyClipboard() != 0 && !SetClipboardData(13, memory).is_null();
        CloseClipboard();
        if !success { GlobalFree(memory); return Err("Cannot copy room code".into()); }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn read() -> Option<String> { None }
#[cfg(not(windows))]
pub fn write(_window: &tauri::WebviewWindow, _text: &str) -> Result<(), String> { Err("Windows pilot required".into()) }
