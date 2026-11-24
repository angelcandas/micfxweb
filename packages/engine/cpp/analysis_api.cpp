// The C API of analysis.wasm: the desktop's measuring and planning code (src/analysis,
// SoundCheck::makePlan, the Practice view's melody and scoring), for a Web Worker or the
// page. No audio thread.
//
// Audio in: the caller copies samples into memory from malloc.
// Strings out: a call returns a length, and the text is at micfx_result (valid until the next call).
#include "SoundCheck.h"
#include "WebJson.h"
#include "analysis/Coach.h"
#include "analysis/Key.h"

#include <string>
#include <vector>

#define MICFX_EXPORT extern "C" __attribute__ ((used, visibility ("default")))

using micfx::web::fixed;
using micfx::web::quoted;

namespace
{
std::string result;
std::vector<float> noiseProfile;

int setResult (const juce::String& json)
{
    result = json.toStdString();
    return (int) result.size();
}
} // namespace

MICFX_EXPORT const char* micfx_result() { return result.c_str(); }

// The Auto Mix styles, in the order "style" indices count them: ["Pop", ...].
MICFX_EXPORT int micfx_styles()
{
    juce::StringArray names;
    for (auto style : analysis::allStyles)
        names.add (quoted (analysis::getStyleName (style)));
    return setResult ("[" + names.joinIntoString (",") + "]");
}

// Sound check: the Live values for a voice (`frames` mono samples after the input gain).
// fit = 0: a new chain in a style (an index into micfx_styles). fit = 1: the chain stays
// and only its levels are fitted, from what it has now (the other arguments).
// Returns { error, values: [[id, value]...], changes: [{ module, text }], notes, advice,
// peak, lufs, noise, sung, noiseBins }; the noise profile is at micfx_noise_profile.
MICFX_EXPORT int micfx_sound_check (const float* samples, int frames, double sampleRate, int style, int fit,
                                    float inputGainDb, float minInputDb, float maxInputDb,
                                    int gate, int classicDeEsser, int denoise, float lowCutHz)
{
    SoundCheck::Plan plan;
    if (fit != 0)
    {
        analysis::fit::Chain chain;
        chain.inputGainDb = inputGainDb;
        chain.minInputDb = minInputDb;
        chain.maxInputDb = maxInputDb;
        chain.gate = gate != 0;
        chain.classicDeEsser = classicDeEsser != 0;
        chain.denoise = denoise != 0;
        plan = SoundCheck::makeFitPlan (samples, frames, sampleRate, chain, lowCutHz);
    }
    else
    {
        const auto count = (int) std::size (analysis::allStyles);
        plan = SoundCheck::makePlan (samples, frames, sampleRate, analysis::allStyles[juce::jlimit (0, count - 1, style)]);
    }

    noiseProfile = plan.noiseProfile;

    juce::StringArray values, changes, notes;
    for (const auto& [id, value] : plan.values)
        values.add ("[" + quoted (id) + "," + fixed (value, 4) + "]");
    for (const auto& change : plan.changes)
        changes.add ("{\"module\":" + quoted (change.module) + ",\"text\":" + quoted (change.text) + "}");
    for (const auto& note : plan.notes)
        notes.add (quoted (note));

    return setResult ("{\"error\":" + quoted (plan.error)
                      + ",\"values\":[" + values.joinIntoString (",") + "]"
                      + ",\"changes\":[" + changes.joinIntoString (",") + "]"
                      + ",\"notes\":[" + notes.joinIntoString (",") + "]"
                      + ",\"advice\":" + quoted (plan.inputAdvice)
                      + ",\"peak\":" + fixed (plan.peakDb, 1)
                      + ",\"lufs\":" + fixed (plan.voiceLufs, 1)
                      + ",\"noise\":" + fixed (plan.noiseDb, 1)
                      + ",\"sung\":" + fixed (plan.voiceSeconds, 1)
                      + ",\"noiseBins\":" + juce::String ((int) noiseProfile.size()) + "}");
}

// The last sound check's room profile for the denoiser (power per bin), micfx_sound_check's noiseBins long.
MICFX_EXPORT const float* micfx_noise_profile() { return noiseProfile.data(); }

//==============================================================================
// Practice: the melody to sing, found in a voice (the guide vocal, or a voice on its own),
// and the song's key. Returns { melody (Song::toString), key ("A minor", or "") }.
MICFX_EXPORT int micfx_find_melody (const float* samples, int frames, double sampleRate, const float* keySamples, int keyFrames)
{
    juce::AudioBuffer<float> voice (const_cast<float**> (&samples), 1, frames);
    const auto song = analysis::coach::findMelody (voice, sampleRate);

    // The key from the backing when there is one, else from the voice.
    juce::String key;
    if (! song.isEmpty())
    {
        const auto* keyData = keyFrames > 0 ? keySamples : samples;
        juce::AudioBuffer<float> keyAudio (const_cast<float**> (&keyData), 1, keyFrames > 0 ? keyFrames : frames);
        if (const auto estimate = analysis::detectKey (keyAudio, sampleRate); estimate.isValid())
            key = estimate.getName();
    }
    return setResult ("{\"melody\":" + quoted (song.isEmpty() ? juce::String() : song.toString()) + ",\"key\":" + quoted (key) + "}");
}

//==============================================================================
// Practice: live scoring, as the desktop's Practice (setSong, restartFrom, addFrames,
// describeScores, describeReport in src/Practice.cpp). One song at a time.
namespace
{
namespace coach = analysis::coach;

struct Scoring
{
    coach::Song song;
    std::vector<coach::Frame> sung;
    std::vector<coach::NoteScore> noteScores;
    std::vector<coach::PhraseScore> phraseScores;
    int nextNote = 0, nextPhrase = 0;
    std::vector<int> changedNotes, changedPhrases;
    bool scoresReset = true;
    double lastSongTime = 0.0;

    void setSong (coach::Song newSong)
    {
        song = std::move (newSong);
        sung.clear();
        noteScores.assign (song.notes.size(), {});
        phraseScores.assign (song.phrases.size(), {});
        nextNote = nextPhrase = 0;
        changedNotes.clear();
        changedPhrases.clear();
        scoresReset = true;
        lastSongTime = 0.0;
    }

    void restartFrom (double songTime)
    {
        sung.erase (std::lower_bound (sung.begin(), sung.end(), songTime,
                                      [] (const coach::Frame& f, double t) { return f.time < t; }),
                    sung.end());

        // Everything that ends after the jump is sung again.
        nextNote = 0;
        while (nextNote < (int) song.notes.size() && song.notes[(size_t) nextNote].end <= songTime)
            ++nextNote;
        nextPhrase = 0;
        while (nextPhrase < (int) song.phrases.size() && song.phrases[(size_t) nextPhrase].endNote <= nextNote
               && song.phrases[(size_t) nextPhrase].end <= songTime)
            ++nextPhrase;

        for (auto i = (size_t) nextNote; i < noteScores.size(); ++i)
            noteScores[i] = {};
        for (auto i = (size_t) nextPhrase; i < phraseScores.size(); ++i)
            phraseScores[i] = {};

        changedNotes.clear();
        changedPhrases.clear();
        scoresReset = true;
        lastSongTime = songTime;
    }

    void addFrames (const std::vector<coach::Frame>& frames, double songTime)
    {
        for (const auto& frame : frames)
            if (sung.empty() || frame.time > sung.back().time)
                sung.push_back (frame);

        lastSongTime = songTime;

        // A note is scored once it has ended (with a moment for its last frames to arrive).
        constexpr double settle = 0.05;
        while (nextNote < (int) song.notes.size() && song.notes[(size_t) nextNote].end + settle <= songTime)
        {
            noteScores[(size_t) nextNote] = coach::scoreNote (song.notes[(size_t) nextNote], sung);
            changedNotes.push_back (nextNote++);
        }

        while (nextPhrase < (int) song.phrases.size() && song.phrases[(size_t) nextPhrase].endNote <= nextNote)
        {
            phraseScores[(size_t) nextPhrase] = coach::scorePhrase (song, nextPhrase, noteScores);
            changedPhrases.push_back (nextPhrase++);
        }
    }

    float getPassScore() const
    {
        double total = 0.0, sum = 0.0;
        for (size_t i = 0; i < phraseScores.size(); ++i)
            if (phraseScores[i].scored)
            {
                const auto w = song.phrases[i].end - song.phrases[i].start;
                total += w;
                sum += w * phraseScores[i].score;
            }
        return total > 0.0 ? (float) (sum / total) : 0.0f;
    }
};

Scoring scoring;

juce::String describeNote (int index, const coach::NoteScore& s)
{
    return "{\"i\":" + juce::String (index) + ",\"sung\":" + micfx::web::boolean (s.sung) + ",\"score\":" + fixed (s.score)
         + ",\"cents\":" + fixed (s.cents) + ",\"inTune\":" + fixed (s.inTune) + ",\"timing\":" + fixed (s.timing, 3)
         + ",\"onset\":" + micfx::web::boolean (s.onsetFound) + ",\"coverage\":" + fixed (s.coverage) + "}";
}

juce::String describePhrase (int index, const coach::PhraseScore& s)
{
    return "{\"i\":" + juce::String (index) + ",\"scored\":" + micfx::web::boolean (s.scored) + ",\"score\":" + fixed (s.score)
         + ",\"pitch\":" + fixed (s.pitchScore) + ",\"timingScore\":" + fixed (s.timingScore) + ",\"steady\":" + fixed (s.steadyScore)
         + ",\"coverage\":" + fixed (s.coverage) + ",\"lean\":" + fixed (s.lean) + ",\"timing\":" + fixed (s.timing, 3)
         + ",\"notesSung\":" + juce::String (s.notesSung) + ",\"notesInTune\":" + juce::String (s.notesInTune) + "}";
}
} // namespace

// The song to score (Song::toString text, `length` bytes at `text`, from malloc). Returns
// { notes: [start, end, pitch, phrase, ...], phrases: [start, end, ...], lowest, highest },
// the desktop's describeSong() parts, or notes: [] when the text has no melody.
MICFX_EXPORT int micfx_score_song (const char* text, int length)
{
    scoring.setSong (coach::Song::fromString (juce::String::fromUTF8 (text, length)));
    const auto& song = scoring.song;
    juce::StringArray notes, phrases;
    for (const auto& n : song.notes)
        notes.add (fixed (n.start, 3) + "," + fixed (n.end, 3) + "," + fixed (n.pitch, 2) + "," + juce::String (n.phrase));
    for (const auto& p : song.phrases)
        phrases.add (fixed (p.start, 3) + "," + fixed (p.end, 3));
    return setResult ("{\"notes\":[" + notes.joinIntoString (",") + "],\"phrases\":[" + phrases.joinIntoString (",")
                      + "],\"lowest\":" + fixed (song.isEmpty() ? 0.0 : song.getLowest(), 2)
                      + ",\"highest\":" + fixed (song.isEmpty() ? 0.0 : song.getHighest(), 2) + "}");
}

// Sung frames ([time, midi] doubles, `count` of them, in song time) up to `songTime`.
MICFX_EXPORT void micfx_score_frames (const double* frames, int count, double songTime)
{
    std::vector<coach::Frame> list ((size_t) juce::jmax (0, count));
    for (int i = 0; i < count; ++i)
        list[(size_t) i] = { frames[i * 2], (float) frames[i * 2 + 1] };
    scoring.addFrames (list, songTime);
}

// The transport jumped: what was sung from `songTime` on is forgotten and scored again.
MICFX_EXPORT void micfx_score_restart (double songTime) { scoring.restartFrom (songTime); }

// Only moves the time on (the song isn't playing).
MICFX_EXPORT void micfx_score_time (double songTime) { scoring.lastSongTime = songTime; }

// The desktop's describeScores: every score so far (all = 1), or what changed since the last
// call (-1 when nothing did), as { reset, from, notes, phrases, pass }.
MICFX_EXPORT int micfx_score_changes (int all)
{
    if (all == 0 && ! scoring.scoresReset && scoring.changedNotes.empty() && scoring.changedPhrases.empty())
        return -1;

    juce::StringArray notes, phrases;
    if (all != 0)
    {
        for (int i = 0; i < scoring.nextNote && i < (int) scoring.noteScores.size(); ++i)
            notes.add (describeNote (i, scoring.noteScores[(size_t) i]));
        for (int i = 0; i < scoring.nextPhrase && i < (int) scoring.phraseScores.size(); ++i)
            phrases.add (describePhrase (i, scoring.phraseScores[(size_t) i]));
    }
    else
    {
        for (auto i : scoring.changedNotes)
            notes.add (describeNote (i, scoring.noteScores[(size_t) i]));
        for (auto i : scoring.changedPhrases)
            phrases.add (describePhrase (i, scoring.phraseScores[(size_t) i]));
        scoring.changedNotes.clear();
        scoring.changedPhrases.clear();
    }

    const auto reset = all != 0 || scoring.scoresReset;
    if (all == 0)
        scoring.scoresReset = false;
    return setResult ("{\"reset\":" + micfx::web::boolean (reset) + ",\"from\":" + fixed (scoring.lastSongTime, 3)
                      + ",\"notes\":[" + notes.joinIntoString (",") + "],\"phrases\":[" + phrases.joinIntoString (",")
                      + "],\"pass\":" + fixed (scoring.getPassScore(), 2) + "}");
}

// The desktop's describeReport: { score, pitch, timing, steady, lean, timingSeconds, scored,
// total, weak, phrases } over the phrases sung so far (the page adds "looping").
MICFX_EXPORT int micfx_score_report()
{
    const auto& song = scoring.song;
    const auto& phraseScores = scoring.phraseScores;
    double total = 0.0, score = 0.0, pitch = 0.0, timing = 0.0, steady = 0.0, lean = 0.0, leanWeight = 0.0, seconds = 0.0;
    int scored = 0;
    juce::StringArray phrases;

    for (size_t i = 0; i < phraseScores.size(); ++i)
    {
        const auto& p = phraseScores[i];
        if (! p.scored)
            continue;
        ++scored;
        phrases.add (describePhrase ((int) i, p));
        const auto w = song.phrases[i].end - song.phrases[i].start;
        total += w;
        score += w * p.score;
        pitch += w * p.pitchScore;
        timing += w * p.timingScore;
        steady += w * p.steadyScore;
        seconds += w * p.timing;
        if (p.notesSung > 0)
        {
            leanWeight += w;
            lean += w * p.lean;
        }
    }

    // The weak phrases: the lowest under 75, worst first.
    std::vector<int> weak;
    for (int i = 0; i < (int) phraseScores.size(); ++i)
        if (phraseScores[(size_t) i].scored && phraseScores[(size_t) i].score < 75.0f)
            weak.push_back (i);
    std::sort (weak.begin(), weak.end(), [&] (int a, int b) { return phraseScores[(size_t) a].score < phraseScores[(size_t) b].score; });
    if (weak.size() > 3)
        weak.resize (3);
    juce::StringArray weakList;
    for (auto i : weak)
        weakList.add (juce::String (i));

    const auto mean = [total] (double v) { return total > 0.0 ? v / total : 0.0; };
    return setResult ("{\"score\":" + fixed (mean (score)) + ",\"pitch\":" + fixed (mean (pitch)) + ",\"timing\":" + fixed (mean (timing))
                      + ",\"steady\":" + fixed (mean (steady)) + ",\"lean\":" + fixed (leanWeight > 0.0 ? lean / leanWeight : 0.0)
                      + ",\"timingSeconds\":" + fixed (mean (seconds), 3) + ",\"scored\":" + juce::String (scored)
                      + ",\"total\":" + juce::String ((int) song.phrases.size()) + ",\"weak\":[" + weakList.joinIntoString (",")
                      + "],\"phrases\":[" + phrases.joinIntoString (",") + "]}");
}
