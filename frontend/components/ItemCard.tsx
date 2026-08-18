"use client";

import { useState } from "react";

type ItemCardProps = {
  name: string;
  location: string;
  date: string;
  description?: string;
  image: string | null;
  user_name?: string | null;
  user_profile_image?: string | null;
};

export default function ItemCard({
  name,
  location,
  date,
  description,
  image,
  user_name,
  user_profile_image,
}: ItemCardProps) {
  const [profileImageError, setProfileImageError] = useState(false);

  const formattedDate = new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <div
      style={{
        border: "1px solid #444",
        borderRadius: "12px",
        overflow: "hidden",
        background: "#111",
        marginTop: "20px",
      }}
    >
      {image && (
        <img
          src={`http://localhost:5000/uploads/${image}`}
          alt={name}
          style={{
            width: "100%",
            height: "260px",
            objectFit: "contain",
            display: "block",
            background: "#222",
          }}
        />
      )}

      <div style={{ padding: "18px" }}>
        <h2 style={{ margin: "0 0 10px 0" }}>{name}</h2>

        <p style={{ margin: "8px 0" }}>
          📍 {location}
        </p>

        <p style={{ margin: "8px 0" }}>
          📅 {formattedDate}
        </p>

        {description && (
          <p style={{ margin: "12px 0 0 0", color: "#bbb" }}>
            📝 {description}
          </p>
        )}

        {/* Reporter */}
        {user_name && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginTop: "15px",
              paddingTop: "12px",
              borderTop: "1px solid #333",
            }}
          >
            {/* Profile picture */}
            <div
              style={{
                width: "32px",
                height: "32px",
                minWidth: "32px",
                borderRadius: "50%",
                overflow: "hidden",
                backgroundColor: "#2563eb",
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "bold",
              }}
            >
              {user_profile_image && !profileImageError ? (
                <img
                  src={user_profile_image}
                  alt=""
                  width={32}
                  height={32}
                  onError={() => setProfileImageError(true)}
                  style={{
                    width: "32px",
                    height: "32px",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              ) : (
                user_name.charAt(0).toUpperCase()
              )}
            </div>

            {/* Reporter name */}
            <span style={{ whiteSpace: "nowrap" }}>
              👤 Reported by <strong>{user_name}</strong>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}