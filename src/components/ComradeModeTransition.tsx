"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";

const ACTIVATION_LINES = [
    "SLEEPER AGENT ACTIVATED",
    "BURNIE COMRADE MODE ONLINE",
    "THE FIVE-YEAR PLAN IS PERFECT",
];

const DEACTIVATION_LINES = [
    "COMRADE MODE STANDING DOWN",
    "RETURNING SAKURA TO CIVILIAN DIALECT",
    "THE ARCHIVE REMEMBERS",
];

export default function ComradeModeTransition() {
    const { comradeTransition, completeComradeTransition } = useI18n();

    useEffect(() => {
        if (!comradeTransition) return;
        const timer = window.setTimeout(completeComradeTransition, 1800);
        return () => window.clearTimeout(timer);
    }, [comradeTransition, completeComradeTransition]);

    if (!comradeTransition) return null;

    const activating = comradeTransition === "activating";
    const lines = activating ? ACTIVATION_LINES : DEACTIVATION_LINES;

    return (
        <div
            className={`comrade-transition ${activating ? "is-activating" : "is-deactivating"}`}
            role="status"
            aria-live="polite"
            aria-label={activating ? "Comrade Mode activated" : "Comrade Mode deactivated"}
        >
            <div className="comrade-transition-scanlines" aria-hidden />
            <div className="comrade-transition-orb" aria-hidden />
            <div className="comrade-transition-card">
                <span className="comrade-transition-kicker">
                    {activating ? "BURNIE SENDERS PROTOCOL" : "SAKURA CIVILIAN PROTOCOL"}
                </span>
                <div className="comrade-transition-mark" aria-hidden>
                    {activating ? "B" : "S"}
                </div>
                <div className="comrade-transition-lines">
                    {lines.map((line, index) => (
                        <span key={line} style={{ animationDelay: `${index * 120}ms` }}>
                            {line}
                        </span>
                    ))}
                </div>
                <div className="comrade-transition-bar" aria-hidden>
                    <span />
                </div>
            </div>
        </div>
    );
}
