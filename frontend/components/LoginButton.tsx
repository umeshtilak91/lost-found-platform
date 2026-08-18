"use client";
export default function LoginButton() {
  const handleGoogleLogin = () => {
    window.location.href = "http://localhost:5000/api/auth/google";
  };

  return (
    <button
      onClick={handleGoogleLogin}
      style={{
        backgroundColor: "#2563eb",
        color: "white",
        padding: "12px 20px",
        border: "none",
        borderRadius: "6px",
        cursor: "pointer",
        marginTop: "20px",
      }}
    >
      🔐 Login with Google
    </button>
  );
}