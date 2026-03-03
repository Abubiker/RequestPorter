use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpRequestPayload {
    method: String,
    url: String,
    headers: Vec<HttpKeyValue>,
    query_params: Vec<HttpKeyValue>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct HttpKeyValue {
    key: String,
    value: String,
    enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpResponsePayload {
    status_code: u16,
    headers: Vec<HttpHeaderPair>,
    body: String,
    duration_ms: u128,
    size_bytes: usize,
    url: String,
    ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpHeaderPair {
    key: String,
    value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpErrorPayload {
    message: String,
    duration_ms: u128,
}

#[tauri::command]
async fn send_http_request(
    payload: HttpRequestPayload,
) -> Result<HttpResponsePayload, HttpErrorPayload> {
    let started = Instant::now();

    let method =
        reqwest::Method::from_bytes(payload.method.as_bytes()).map_err(|error| HttpErrorPayload {
            message: format!("Invalid HTTP method: {error}"),
            duration_ms: started.elapsed().as_millis(),
        })?;

    let timeout_ms = payload.timeout_ms.unwrap_or(30_000);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| HttpErrorPayload {
            message: format!("Failed to build HTTP client: {error}"),
            duration_ms: started.elapsed().as_millis(),
        })?;

    let mut request_builder = client.request(method, payload.url);

    let query_params: Vec<(&str, &str)> = payload
        .query_params
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
        .map(|item| (item.key.as_str(), item.value.as_str()))
        .collect();
    if !query_params.is_empty() {
        request_builder = request_builder.query(&query_params);
    }

    let mut header_map = HeaderMap::new();
    for header in payload
        .headers
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
    {
        let header_name = HeaderName::from_bytes(header.key.trim().as_bytes()).map_err(|error| {
            HttpErrorPayload {
                message: format!("Invalid header name '{}': {error}", header.key),
                duration_ms: started.elapsed().as_millis(),
            }
        })?;
        let header_value = HeaderValue::from_str(header.value.trim()).map_err(|error| {
            HttpErrorPayload {
                message: format!("Invalid header value for '{}': {error}", header.key),
                duration_ms: started.elapsed().as_millis(),
            }
        })?;
        header_map.insert(header_name, header_value);
    }
    if !header_map.is_empty() {
        request_builder = request_builder.headers(header_map);
    }

    if let Some(body) = payload.body {
        if !body.is_empty() {
            request_builder = request_builder.body(body);
        }
    }

    let response = request_builder
        .send()
        .await
        .map_err(|error| HttpErrorPayload {
            message: format!("Request failed: {error}"),
            duration_ms: started.elapsed().as_millis(),
        })?;

    let status_code = response.status().as_u16();
    let ok = response.status().is_success();
    let url = response.url().to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(key, value)| HttpHeaderPair {
            key: key.as_str().to_string(),
            value: value.to_str().unwrap_or("<binary>").to_string(),
        })
        .collect::<Vec<_>>();
    let bytes = response.bytes().await.map_err(|error| HttpErrorPayload {
        message: format!("Failed to read response body: {error}"),
        duration_ms: started.elapsed().as_millis(),
    })?;
    let size_bytes = bytes.len();
    let body = String::from_utf8_lossy(&bytes).to_string();

    Ok(HttpResponsePayload {
        status_code,
        headers,
        body,
        duration_ms: started.elapsed().as_millis(),
        size_bytes,
        url,
        ok,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![send_http_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
