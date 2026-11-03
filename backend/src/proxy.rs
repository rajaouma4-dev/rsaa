use std::net::IpAddr;

fn trusted(ip: IpAddr, rule: &str) -> bool {
    let (network, bits) = rule.split_once('/').map_or((rule, None), |(a, b)| (a, Some(b)));
    let Ok(network) = network.parse::<IpAddr>() else { return false; };
    match (ip, network) {
        (IpAddr::V4(ip), IpAddr::V4(network)) => {
            let Some(bits) = bits.map_or(Some(32), |s| s.parse::<u32>().ok()).filter(|b| *b <= 32) else { return false; };
            let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
            u32::from(ip) & mask == u32::from(network) & mask
        },
        (IpAddr::V6(ip), IpAddr::V6(network)) => {
            let Some(bits) = bits.map_or(Some(128), |s| s.parse::<u32>().ok()).filter(|b| *b <= 128) else { return false; };
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
            u128::from(ip) & mask == u128::from(network) & mask
        },
        _ => false,
    }
}

/// Walk from the socket peer through explicitly trusted proxies, never blindly
/// accepting a client-provided first X-Forwarded-For value.
pub fn client_ip(peer: IpAddr, headers: &str, rules: &[String]) -> IpAddr {
    let is_trusted = |ip| rules.iter().any(|rule| trusted(ip, rule));
    if !is_trusted(peer) { return peer; }
    let values: Vec<_> = headers.lines().filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("x-forwarded-for")).map(|(_, value)| value).collect();
    if values.len() != 1 { return peer; }
    let hops: Vec<_> = values[0].split(',').collect();
    if hops.len() > 16 { return peer; }
    let mut current = peer;
    for hop in hops.iter().rev() {
        if !is_trusted(current) { break; }
        let Ok(ip) = hop.trim().parse() else { return peer; };
        current = ip;
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forwarded_headers_are_only_accepted_from_configured_proxy_chain() {
        let peer = "10.1.2.3".parse().unwrap();
        let rules = vec!["10.0.0.0/8".into()];
        assert_eq!(client_ip(peer, "X-Forwarded-For: 192.0.2.1, 198.51.100.5", &rules), "198.51.100.5".parse::<IpAddr>().unwrap());
        assert_eq!(client_ip(peer, "X-Forwarded-For: 192.0.2.1", &[]), peer);
        assert_eq!(client_ip(peer, "X-Forwarded-For: invalid", &rules), peer);
        assert_eq!(client_ip(peer, "X-Forwarded-For: 192.0.2.1\nX-Forwarded-For: 198.51.100.1", &rules), peer);
    }
}
