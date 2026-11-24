#pragma once

// JSON numbers and strings by hand for the web's C APIs. JUCE's double-to-text goes through
// std::ostream, which traps in the standalone wasm, so numbers are written digit by digit.
#include <juce_core/juce_core.h>

#include <cmath>

namespace micfx::web
{
inline juce::String fixed (double value, int decimals = 2)
{
    if (! std::isfinite (value))
        return "0";
    const auto scale = std::pow (10.0, decimals);
    auto scaled = (juce::int64) std::llround (std::abs (value) * scale);
    const auto whole = scaled / (juce::int64) scale;
    auto fraction = juce::String (scaled % (juce::int64) scale).paddedLeft ('0', decimals);
    return (value < 0 && scaled != 0 ? "-" : "") + juce::String (whole) + (decimals > 0 ? "." + fraction : juce::String());
}

inline juce::String quoted (const juce::String& text)
{
    juce::String out ("\"");
    for (auto c : text)
    {
        if (c == '"' || c == '\\')
            out << '\\' << juce::String::charToString (c);
        else if (c == '\n')
            out << "\\n";
        else if (c < 0x20)
            out << "\\u" << juce::String::toHexString ((int) c).paddedLeft ('0', 4);
        else
            out << juce::String::charToString (c);
    }
    return out + "\"";
}

inline juce::String boolean (bool value) { return value ? "true" : "false"; }
} // namespace micfx::web
