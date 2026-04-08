use std::net::SocketAddr;

use warp::hyper::Body;
use warp::Filter;

use crate::proxy::proxy_request;
use crate::server::cors;

pub async fn start() -> u16 {
    let route = warp::path("p")
        .and(warp::path::tail())
        .and_then(|tail: warp::path::Tail| async move {
            let encoded_url = tail.as_str();
            let result = proxy_request(encoded_url).await;
            Ok::<_, warp::Rejection>(
                warp::http::Response::builder()
                    .status(result.status)
                    .header("Content-Type", &result.content_type)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Body::from(result.data))
                    .unwrap(),
            )
        })
        .with(cors());

    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
    let (addr, server) = warp::serve(route).bind_ephemeral(addr);
    tokio::spawn(server);

    println!("[ProxyServer] http://127.0.0.1:{}", addr.port());
    addr.port()
}
