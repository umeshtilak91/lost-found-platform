"use client";

import { useEffect, useState } from "react";

type User = {
    id: number;
    name: string;
    email: string;
    profile_image: string | null;
    mobile_number: string | null;
    allow_phone_contact: boolean;
};

export default function ProfilePage() {
    const [user, setUser] = useState<User | null>(null);
    const [mobileNumber, setMobileNumber] = useState("");
    const [allowPhoneContact, setAllowPhoneContact] = useState(false);
    const [imageError, setImageError] = useState(false);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    // ======================================================
    // GET CURRENT USER
    // ======================================================

    useEffect(() => {
        const fetchUser = async () => {
            try {
                const response = await fetch(
                    "http://localhost:5000/api/auth/me",
                    {
                        credentials: "include",
                    }
                );

                const data = await response.json();

                if (!data.loggedIn) {
                    setError("Please login with Google first.");
                    setLoading(false);
                    return;
                }

                setUser(data.user);
                setImageError(false);

                setMobileNumber(data.user.mobile_number || "");
                setAllowPhoneContact(
                    data.user.allow_phone_contact || false
                );
            } catch (err) {
                console.error(err);
                setError("Unable to load profile.");
            } finally {
                setLoading(false);
            }
        };

        fetchUser();
    }, []);

    // ======================================================
    // SAVE PROFILE
    // ======================================================

    const handleSave = async () => {
        setMessage("");
        setError("");

        setSaving(true);

        try {
            const response = await fetch(
                "http://localhost:5000/api/auth/profile",
                {
                    method: "PUT",
                    credentials: "include",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        mobile_number: mobileNumber,
                        allow_phone_contact: allowPhoneContact,
                    }),
                }
            );

            const data = await response.json();

            if (!response.ok) {
                setError(data.message || "Failed to update profile.");
                setSaving(false);
                return;
            }

            setUser(data.user);

            setMobileNumber(data.user.mobile_number || "");

            setAllowPhoneContact(
                data.user.allow_phone_contact || false
            );

            setMessage("Profile updated successfully!");
        } catch (err) {
            console.error(err);
            setError("Something went wrong. Please try again.");
        } finally {
            setSaving(false);
        }
    };

    // ======================================================
    // LOADING
    // ======================================================

    if (loading) {
        return (
            <main
                style={{
                    minHeight: "100vh",
                    background: "#020617",
                    color: "white",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    fontFamily: "Arial, sans-serif",
                }}
            >
                Loading profile...
            </main>
        );
    }

    // ======================================================
    // NOT LOGGED IN
    // ======================================================

    if (!user) {
        return (
            <main
                style={{
                    minHeight: "100vh",
                    background: "#020617",
                    color: "white",
                    padding: "40px",
                    fontFamily: "Arial, sans-serif",
                }}
            >
                <h1>👤 My Profile</h1>

                <p style={{ color: "#f87171" }}>
                    {error || "Please login first."}
                </p>
            </main>
        );
    }

    // ======================================================
    // PROFILE PAGE
    // ======================================================

    return (
        <main
            style={{
                minHeight: "100vh",
                background: "#020617",
                color: "white",
                padding: "40px 20px",
                fontFamily: "Arial, sans-serif",
            }}
        >
            <div
                style={{
                    maxWidth: "600px",
                    margin: "0 auto",
                }}
            >
                <h1
                    style={{
                        fontSize: "32px",
                        marginBottom: "30px",
                    }}
                >
                    👤 My Profile
                </h1>

                {/* PROFILE CARD */}

                <div
                    style={{
                        background: "#111827",
                        borderRadius: "16px",
                        padding: "30px",
                        border: "1px solid #1f2937",
                    }}
                >
                    {/* PROFILE IMAGE */}

                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "20px",
                            marginBottom: "30px",
                        }}
                    >
                        {user.profile_image && !imageError ? (
                            <img
                                src={user.profile_image}
                                alt={user.name}
                                referrerPolicy="no-referrer"
                                onError={() => setImageError(true)}
                                style={{
                                    width: "80px",
                                    height: "80px",
                                    borderRadius: "50%",
                                    objectFit: "cover",
                                    display: "block",
                                }}
                            />
                        ) : (
                            <div
                                style={{
                                    width: "80px",
                                    height: "80px",
                                    borderRadius: "50%",
                                    background: "#0284c7",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: "40px",
                                    fontWeight: "bold",
                                    color: "white",
                                }}
                            >
                                {user.name?.charAt(0).toUpperCase() || "U"}
                            </div>
                        )}

                        <div>
                            <h2
                                style={{
                                    margin: 0,
                                    fontSize: "24px",
                                }}
                            >
                                {user.name}
                            </h2>

                            <p
                                style={{
                                    marginTop: "6px",
                                    color: "#9ca3af",
                                }}
                            >
                                {user.email}
                            </p>
                        </div>
                    </div>

                    {/* DIVIDER */}

                    <div
                        style={{
                            height: "1px",
                            background: "#374151",
                            marginBottom: "25px",
                        }}
                    />

                    {/* MOBILE NUMBER */}

                    <label
                        style={{
                            display: "block",
                            fontWeight: "bold",
                            marginBottom: "8px",
                        }}
                    >
                        Mobile Number
                    </label>

                    <input
                        type="tel"
                        value={mobileNumber}
                        onChange={(e) =>
                            setMobileNumber(e.target.value)
                        }
                        placeholder="+91 9876543210"
                        style={{
                            width: "100%",
                            padding: "13px",
                            borderRadius: "8px",
                            border: "1px solid #374151",
                            background: "#020617",
                            color: "white",
                            fontSize: "16px",
                            boxSizing: "border-box",
                            marginBottom: "20px",
                        }}
                    />

                    {/* PHONE CONTACT CHECKBOX */}

                    <label
                        style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: "12px",
                            cursor: "pointer",
                            marginBottom: "10px",
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={allowPhoneContact}
                            onChange={(e) =>
                                setAllowPhoneContact(e.target.checked)
                            }
                            style={{
                                width: "18px",
                                height: "18px",
                                marginTop: "2px",
                            }}
                        />

                        <span>
                            <strong>
                                Allow people to contact me by phone
                            </strong>

                            <br />

                            <small
                                style={{
                                    color: "#9ca3af",
                                }}
                            >
                                Your mobile number will only be shown
                                when you enable this option.
                            </small>
                        </span>
                    </label>

                    {/* SUCCESS MESSAGE */}

                    {message && (
                        <div
                            style={{
                                marginTop: "20px",
                                padding: "12px",
                                borderRadius: "8px",
                                background: "#064e3b",
                                color: "#6ee7b7",
                            }}
                        >
                            ✅ {message}
                        </div>
                    )}

                    {/* ERROR MESSAGE */}

                    {error && (
                        <div
                            style={{
                                marginTop: "20px",
                                padding: "12px",
                                borderRadius: "8px",
                                background: "#450a0a",
                                color: "#fca5a5",
                            }}
                        >
                            ❌ {error}
                        </div>
                    )}

                    {/* SAVE BUTTON */}

                    <button
                        onClick={handleSave}
                        disabled={saving}
                        style={{
                            width: "100%",
                            marginTop: "25px",
                            padding: "14px",
                            border: "none",
                            borderRadius: "8px",
                            background: saving ? "#374151" : "#16a34a",
                            color: "white",
                            fontSize: "16px",
                            fontWeight: "bold",
                            cursor: saving ? "not-allowed" : "pointer",
                        }}
                    >
                        {saving ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </div>
        </main>
    );
}