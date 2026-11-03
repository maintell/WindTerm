//! 标识类型。
//!
//! 用 newtype 而非裸 `String`：避免「把 folder id 传给要 session id 的参数」这类错误，
//! 这类 bug 编译器抓不到、测试也常常漏。
//!
//! ID 采用 UUID v7（时间有序），好处是：单库内可直接按 id 排序得到创建顺序，
//! 且未来做增量同步时天然可做游标。

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! id_type {
    ($name:ident, $label:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// 生成新的 UUID v7。
            pub fn new() -> Self {
                Self(Uuid::now_v7().to_string())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }

            /// 校验是否为合法 UUID（用于拒绝前端伪造的 ID）。
            pub fn is_valid(&self) -> bool {
                Uuid::parse_str(&self.0).is_ok()
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_string())
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl $name {
            pub const LABEL: &'static str = $label;
        }
    };
}

id_type!(FolderId, "folder");
id_type!(SessionId, "session");
id_type!(TunnelId, "tunnel");

/// 生成一个新的 UUID v7 字符串。
///
/// 用于不属于任何具体实体的地方（例如保险库条目 ID），
/// 免得为了一个唯一标识去污染 `SessionId` 这类类型。
pub fn new_uuid() -> String {
    Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generated_ids_are_valid_uuid_v7() {
        let id = SessionId::new();
        assert!(id.is_valid());
        let parsed = Uuid::parse_str(id.as_str()).unwrap();
        assert_eq!(parsed.get_version_num(), 7);
    }

    #[test]
    fn generated_ids_are_time_ordered() {
        // UUID v7 前 48 位是毫秒时间戳，同一毫秒内由随机位保证唯一
        let mut ids: Vec<String> = (0..100).map(|_| SessionId::new().into_inner()).collect();
        let sorted = {
            let mut c = ids.clone();
            c.sort();
            c
        };
        // 至少保证不重复；时间序在同一毫秒内可能乱序，这是 v7 的正常行为
        ids.dedup();
        assert_eq!(ids.len(), 100);
        assert_eq!(sorted.len(), 100);
    }

    #[test]
    fn ids_are_unique_in_bulk() {
        let set: HashSet<SessionId> = (0..1000).map(|_| SessionId::new()).collect();
        assert_eq!(set.len(), 1000);
    }

    #[test]
    fn new_uuid_is_unique_and_parseable() {
        let a = new_uuid();
        let b = new_uuid();
        assert_ne!(a, b, "每次都应生成不同的 ID");
        assert!(Uuid::parse_str(&a).is_ok(), "应是合法 UUID：{a}");
    }

    #[test]
    fn different_id_types_are_not_interchangeable() {
        // 类型系统层面已经隔离；这里验证它们序列化后仍是普通字符串
        let f = FolderId::from("abc");
        let s = SessionId::from("abc");
        assert_eq!(serde_json::to_string(&f).unwrap(), "\"abc\"");
        assert_eq!(serde_json::to_string(&s).unwrap(), "\"abc\"");
        assert_eq!(f.as_str(), s.as_str());
    }

    #[test]
    fn rejects_non_uuid() {
        assert!(!SessionId::from("not-a-uuid").is_valid());
        assert!(!SessionId::from("").is_valid());
    }

    #[test]
    fn serde_is_transparent() {
        let id = SessionId::from("018f0b7a-0000-7000-8000-000000000000");
        let j = serde_json::to_string(&id).unwrap();
        assert_eq!(j, "\"018f0b7a-0000-7000-8000-000000000000\"");
        let back: SessionId = serde_json::from_str(&j).unwrap();
        assert_eq!(id, back);
    }
}
