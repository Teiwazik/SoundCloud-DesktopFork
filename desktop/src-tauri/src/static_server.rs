use std::net::SocketAddr;
use std::path::PathBuf;
use std::{collections::HashMap, convert::Infallible};

use tauri::{Emitter, Manager};
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use warp::http::{Response, StatusCode};
use warp::hyper::Body;
use warp::Filter;

use crate::emit_window_visibility;
use crate::server::cors;

const PREFERRED_STATIC_PORT: u16 = 58334;

fn content_type_for(filename: &str) -> &'static str {
    if filename.ends_with(".png") {
        "image/png"
    } else if filename.ends_with(".webp") {
        "image/webp"
    } else if filename.ends_with(".gif") {
        "image/gif"
    } else if filename.ends_with(".svg") {
        "image/svg+xml"
    } else if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "application/octet-stream"
    }
}

fn with_app_handle(
    app_handle: tauri::AppHandle,
) -> impl Filter<Extract = (tauri::AppHandle,), Error = Infallible> + Clone {
    warp::any().map(move || app_handle.clone())
}

fn rpc_open_response(title: &str, body: &str) -> Response<Body> {
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    body {{
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #09090c;
      color: rgba(255, 255, 255, 0.86);
      min-height: 100vh;
      display: grid;
      place-items: center;
    }}
    .card {{
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      border-radius: 16px;
      padding: 18px 20px;
      width: min(420px, calc(100vw - 36px));
      box-shadow: 0 14px 42px rgba(0,0,0,0.45);
    }}
    h1 {{ font-size: 16px; margin: 0 0 8px; }}
    p {{ margin: 0; color: rgba(255,255,255,0.64); font-size: 13px; line-height: 1.45; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>{title}</h1>
    <p>{body}</p>
  </div>
</body>
</html>"#,
    );

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .body(Body::from(html))
        .unwrap()
}

fn emit_rpc_open_to_app(app: &tauri::AppHandle, urn: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        emit_window_visibility(app, true);

        let _ = app.emit("discord:open-track", urn.to_string());
        let _ = window.emit("discord:open-track", urn.to_string());

        if let Ok(urn_json) = serde_json::to_string(urn) {
            let js = format!("window.__scdRpcOpenTrack?.({urn_json});");
            let _ = window.eval(&js);
        }
    }
}

fn transparent_png_bytes() -> &'static [u8] {
    // 1x1 transparent PNG
    &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0,
        5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]
}

pub async fn start(wallpapers_dir: PathBuf, app_handle: tauri::AppHandle) -> u16 {
    let wallpapers = wallpapers_dir.clone();
    let rpc_open_app = app_handle.clone();
    let rpc_pixel_app = app_handle;

    let wallpaper_route = warp::path("wallpapers")
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and_then(move |filename: String| {
            let dir = wallpapers.clone();
            async move {
                if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
                    return Ok::<_, warp::Rejection>(
                        Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .body(Body::empty())
                            .unwrap(),
                    );
                }

                let path = dir.join(&filename);
                let mut file = match File::open(&path).await {
                    Ok(f) => f,
                    Err(_) => {
                        return Ok(Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Body::empty())
                            .unwrap());
                    }
                };

                let metadata = file.metadata().await.unwrap();
                let total = metadata.len();
                let ct = content_type_for(&filename);

                let mut buf = Vec::with_capacity(total as usize);
                file.read_to_end(&mut buf).await.unwrap_or_default();

                Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", ct)
                    .header("Content-Length", total.to_string())
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Body::from(buf))
                    .unwrap())
            }
        });

    let rpc_open_route = warp::path!("rpc" / "open")
        .and(warp::query::<HashMap<String, String>>())
        .and(with_app_handle(rpc_open_app))
        .and_then(
            |query: HashMap<String, String>, app: tauri::AppHandle| async move {
                let urn = query
                    .get("urn")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());

                let Some(urn) = urn else {
                    return Ok::<_, warp::Rejection>(rpc_open_response(
                        "Missing track",
                        "Track URN is missing in the RPC link.",
                    ));
                };

                emit_rpc_open_to_app(&app, &urn);

                Ok(rpc_open_response(
                    "Opened in SoundCloud Desktop",
                    "Track was sent to the desktop app. You can return to Discord now.",
                ))
            },
        );

    let rpc_pixel_route = warp::path!("rpc" / "pixel")
        .and(warp::query::<HashMap<String, String>>())
        .and(with_app_handle(rpc_pixel_app))
        .and_then(
            |query: HashMap<String, String>, app: tauri::AppHandle| async move {
                let urn = query
                    .get("urn")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());

                if let Some(urn) = urn {
                    emit_rpc_open_to_app(&app, &urn);
                }

                Ok::<_, warp::Rejection>(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "image/png")
                        .header("Cache-Control", "no-store")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Body::from(transparent_png_bytes().to_vec()))
                        .unwrap(),
                )
            },
        );

    let routes = wallpaper_route
        .or(rpc_open_route)
        .or(rpc_pixel_route)
        .with(cors());

    let preferred_addr: SocketAddr = ([127, 0, 0, 1], PREFERRED_STATIC_PORT).into();
    let addr = match warp::serve(routes.clone()).try_bind_ephemeral(preferred_addr) {
        Ok((addr, server)) => {
            tokio::spawn(server);
            addr
        }
        Err(err) => {
            eprintln!(
                "[StaticServer] Preferred port {} busy ({}), falling back to random port",
                PREFERRED_STATIC_PORT, err
            );
            let fallback_addr: SocketAddr = ([127, 0, 0, 1], 0).into();
            let (addr, server) = warp::serve(routes).bind_ephemeral(fallback_addr);
            tokio::spawn(server);
            addr
        }
    };

    println!("[StaticServer] http://127.0.0.1:{}", addr.port());
    addr.port()
}
