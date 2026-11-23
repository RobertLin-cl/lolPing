use serde_json::Value;
use url::Url;

pub const API: &str = "https://api.github.com/repos/RobertLin-cl/lolPing/releases/latest";
pub const MAX_INSTALLER: u64 = 256 * 1024 * 1024;

#[derive(Default)]
pub struct Schedule { on: bool, due: Option<u64> }
impl Schedule {
    pub fn configure(&mut self,on: bool,now: u64) {
        if self.on != on { self.on = on; self.due = on.then_some(now.saturating_add(10_000)); }
    }
    pub fn ready(&self,now: u64) -> bool { self.on && self.due.is_some_and(|at| now >= at) }
    pub fn finished(&mut self,now: u64) { self.due = self.on.then_some(now.saturating_add(6 * 60 * 60 * 1000)); }
}

pub fn version(text: &str) -> Option<[u64;3]> {
    let parts: Option<Vec<u64>> = text.split('.').map(|p| {
        if p.is_empty() || p.len() > 9 || !p.bytes().all(|b| b.is_ascii_digit()) { None } else { p.parse().ok() }
    }).collect();
    parts?.try_into().ok()
}
pub fn newer(candidate: &str,current: &str) -> bool { version(candidate).zip(version(current)).is_some_and(|(a,b)| a > b) }
pub fn digest(text: &str) -> bool { text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

#[derive(Clone, Default)]
pub struct Policy { pub test_origin: Option<Url> }
impl Policy {
    pub fn test(origin: &str) -> Result<Self,String> {
        let url = Url::parse(origin).map_err(|e| e.to_string())?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none()
            || !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err("Update smoke requires one loopback HTTP origin".into());
        }
        Ok(Self { test_origin:Some(url) })
    }
    pub fn api(&self) -> String { self.test_origin.as_ref().map(|u| format!("{}releases/latest",u)).unwrap_or(API.into()) }
    pub fn allowed(&self,text: &str) -> bool {
        let Ok(url) = Url::parse(text) else { return false; };
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return false; }
        if let Some(test) = &self.test_origin { return url.origin() == test.origin(); }
        if url.scheme() != "https" || url.port_or_known_default() != Some(443) { return false; }
        match url.host_str() {
            Some("api.github.com") => url.path().starts_with("/repos/RobertLin-cl/lolPing/releases/"),
            Some("github.com") => url.path().starts_with("/RobertLin-cl/lolPing/releases/"),
            Some("release-assets.githubusercontent.com") => true,
            _ => false,
        }
    }
    fn asset_url(&self,tag: &str,name: &str) -> String {
        self.test_origin.as_ref().map(|u| format!("{}assets/{name}",u))
            .unwrap_or_else(|| format!("https://github.com/RobertLin-cl/lolPing/releases/download/{tag}/{name}"))
    }
}

#[derive(Clone, Debug)]
pub struct Asset { pub name:String, pub url:String, pub hash:String, pub size:u64 }
#[derive(Clone, Debug)]
pub struct Release { pub version:String, pub notes:String, pub manifest:Asset, pub installer:Asset }

fn asset(release: &Value,name: &str,tag: &str,policy: &Policy,max: u64) -> Result<Asset,String> {
    let assets = release["assets"].as_array().ok_or("Invalid release assets")?;
    let matches: Vec<&Value> = assets.iter().filter(|a| a["name"] == name).collect();
    if matches.len() != 1 { return Err("Missing or duplicate Rust update asset".into()); }
    let value = matches[0];
    let hash = value["digest"].as_str().and_then(|s| s.strip_prefix("sha256:")).filter(|s| digest(s)).ok_or("Missing Rust asset SHA-256")?;
    let size = value["size"].as_u64().filter(|&s| s > 0 && s <= max).ok_or("Invalid Rust asset size")?;
    let url = value["browser_download_url"].as_str().ok_or("Missing Rust asset URL")?;
    if url != policy.asset_url(tag,name) || !policy.allowed(url) { return Err("Rust asset is outside the fork release".into()); }
    Ok(Asset { name:name.into(),url:url.into(),hash:hash.into(),size })
}

pub fn release(value: &Value,current: &str,policy: &Policy) -> Result<Option<Release>,String> {
    if value["draft"] != false || value["prerelease"] != false { return Ok(None); }
    let tag = value["tag_name"].as_str().ok_or("Missing release tag")?;
    let text = tag.strip_prefix("desktop-pilot-v").or_else(|| tag.strip_prefix('v')).unwrap_or("");
    if !newer(text,current) { return Ok(None); }
    if !value["assets"].as_array().is_some_and(|a| a.iter().any(|v| v["name"] == "desktop-pilot-update.json")) { return Ok(None); }
    let installer = asset(value,&format!("lolPing-Desktop-Pilot-Setup-{text}-x64.exe"),tag,policy,MAX_INSTALLER)?;
    let manifest = asset(value,"desktop-pilot-update.json",tag,policy,65536)?;
    Ok(Some(Release { version:text.into(),notes:format!("https://github.com/RobertLin-cl/lolPing/releases/tag/{tag}"),manifest,installer }))
}

pub fn verify_manifest(bytes: &[u8],release: &Release) -> Result<(),String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if value["schema"] != 1 || value["appId"] != crate::runtime_files::APP_ID || value["runtime"] != "tauri" || value["platform"] != "windows-x64"
        || value["version"] != release.version || value["installer"] != release.installer.name || value["sha256"] != release.installer.hash
        || value["size"] != release.installer.size { return Err("Rust update manifest does not match the release asset".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn schedules_from_completion_without_bursts_and_cancels_when_disabled() {
        let mut schedule = Schedule::default();
        schedule.configure(true,1000); assert!(!schedule.ready(10999)); assert!(schedule.ready(11000));
        schedule.finished(50000); assert!(!schedule.ready(50000 + 6 * 60 * 60 * 1000 - 1));
        assert!(schedule.ready(50000 + 6 * 60 * 60 * 1000));
        schedule.configure(false,90000000); assert!(!schedule.ready(90000001));
        schedule.configure(true,90000001); assert!(!schedule.ready(90010000)); assert!(schedule.ready(90010001));
    }
    #[test]
    fn compares_numeric_versions_and_ignores_electron_only_prerelease_and_downgrade_feeds() {
        assert!(newer("0.10.0","0.9.9")); assert!(!newer("0.6.7-beta","0.6.6"));
        assert!(!newer("0.6.7\n","0.6.6")); assert!(!newer("0.6.7","0.6.7"));
        assert!(release(&json!({"draft":false,"prerelease":false,"tag_name":"v9.0.0","assets":[{"name":"lolPing-Setup-9.0.0.exe"}]}),"0.6.7",&Policy::default()).unwrap().is_none());
    }
    #[test]
    fn limits_redirects_to_fork_downloads_and_the_same_isolated_test_origin() {
        let p = Policy::default(); assert!(p.allowed(API));
        for url in ["http://api.github.com/repos/RobertLin-cl/lolPing/releases/latest","https://github.com/darrenprx/lolPing/releases/latest",
            "https://github.com.evil.test/RobertLin-cl/lolPing/releases/latest","https://api.github.com/repos/other/repo/releases/latest","https://evil.test/file"] { assert!(!p.allowed(url)); }
        assert!(Policy::test("http://127.0.0.1:1234/").unwrap().allowed("http://127.0.0.1:1234/assets/file"));
        assert!(!Policy::test("http://127.0.0.1:1234/").unwrap().allowed("http://127.0.0.1:1235/assets/file"));
        assert!(Policy::test("http://localhost:1234/").is_err());
    }
    #[test]
    fn requires_both_release_digests_and_an_exact_rust_manifest() {
        let p = Policy::default(); let name = "lolPing-Desktop-Pilot-Setup-0.6.8-x64.exe";
        let make = |name| json!({"name":name,"browser_download_url":format!("https://github.com/RobertLin-cl/lolPing/releases/download/v0.6.8/{name}"),"digest":format!("sha256:{}","a".repeat(64)),"size":123});
        let value = json!({"draft":false,"prerelease":false,"tag_name":"v0.6.8","assets":[make(name),make("desktop-pilot-update.json")]});
        let r = release(&value,"0.6.7",&p).unwrap().unwrap();
        let mut m = json!({"schema":1,"appId":crate::runtime_files::APP_ID,"runtime":"tauri","platform":"windows-x64","version":"0.6.8","installer":name,"sha256":"a".repeat(64),"size":123});
        assert!(verify_manifest(m.to_string().as_bytes(),&r).is_ok());
        m["runtime"] = "electron".into(); assert!(verify_manifest(m.to_string().as_bytes(),&r).is_err());
        let mut bad = value; bad["assets"][0]["digest"] = Value::Null;
        assert!(release(&bad,"0.6.7",&p).is_err());
    }
}
