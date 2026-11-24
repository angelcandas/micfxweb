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
#include "analysis/Lyrics.h"
#include "analysis/Structure.h"
#include "daw/Warp.h"

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
namespace lyrics = analysis::lyrics;
coach::Song melody;   // the song as it is, for the lyrics
lyrics::Lyrics words; // the song's lyrics

int describeSong (const coach::Song& song)
{
    juce::StringArray notes, phrases;
    for (const auto& n : song.notes)
        notes.add (fixed (n.start, 3) + "," + fixed (n.end, 3) + "," + fixed (n.pitch, 2) + "," + juce::String (n.phrase));
    for (const auto& p : song.phrases)
        phrases.add (fixed (p.start, 3) + "," + fixed (p.end, 3));
    return setResult ("{\"notes\":[" + notes.joinIntoString (",") + "],\"phrases\":[" + phrases.joinIntoString (",")
                      + "],\"lowest\":" + fixed (song.isEmpty() ? 0.0 : song.getLowest(), 2)
                      + ",\"highest\":" + fixed (song.isEmpty() ? 0.0 : song.getHighest(), 2) + "}");
}

MICFX_EXPORT int micfx_score_song (const char* text, int length)
{
    scoring.setSong (coach::Song::fromString (juce::String::fromUTF8 (text, length)));
    melody = scoring.song;
    words = {};
    return describeSong (scoring.song);
}

// The song in another key and speed (as it plays now), scored again from `songTime` on.
MICFX_EXPORT int micfx_score_shift (double semitones, double speed, double songTime)
{
    const auto neutral = std::abs (speed - 1.0) < 1.0e-3 && std::abs (semitones) < 5.0e-3;
    scoring.song = neutral || melody.isEmpty() ? melody : melody.transformed (semitones, speed);
    if (scoring.noteScores.size() != scoring.song.notes.size())
        scoring.noteScores.assign (scoring.song.notes.size(), {});
    if (scoring.phraseScores.size() != scoring.song.phrases.size())
        scoring.phraseScores.assign (scoring.song.phrases.size(), {});
    scoring.restartFrom (songTime);
    return describeSong (scoring.song);
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

//==============================================================================
// Practice's lyrics (analysis/Lyrics), placed on the melody of the song set with
// micfx_score_song. Each call answers { lines: [{ text, start, end, pinned, timed, words:
// [text, start, ...] }], saved, lrc }: `saved` is what the song's folder keeps.
namespace
{
int describeLyrics()
{
    juce::StringArray lines;
    for (const auto& line : words.lines)
    {
        juce::StringArray list;
        for (const auto& w : line.words)
            list.add (quoted (w.text) + "," + fixed (w.start, 3));
        lines.add ("{\"text\":" + quoted (line.text) + ",\"start\":" + fixed (line.start, 3) + ",\"end\":" + fixed (line.end, 3)
                   + ",\"pinned\":" + micfx::web::boolean (line.pinned) + ",\"timed\":" + micfx::web::boolean (line.timed) + ",\"words\":[" + list.joinIntoString (",") + "]}");
    }
    return setResult ("{\"lines\":[" + lines.joinIntoString (",") + "],\"saved\":" + quoted (words.isEmpty() ? juce::String() : words.toString())
                      + ",\"lrc\":" + quoted (words.isEmpty() ? juce::String() : words.toLrc()) + "}");
}
}

/** New lyrics: pasted text or an .lrc (`kept` 0), or what the song's folder kept (1). */
MICFX_EXPORT int micfx_lyrics_set (const char* text, int length, int kept)
{
    const auto source = juce::String::fromUTF8 (text, length);
    if (kept)
    {
        words = lyrics::Lyrics::fromString (source);
        lyrics::timeWords (words, melody);
    }
    else
    {
        words = lyrics::parse (source);
        if (! words.fromLrc)
            lyrics::align (words, melody);
        else
            lyrics::timeWords (words, melody);
    }
    return describeLyrics();
}

/** Places the lines again (all: the ones set by hand too). */
MICFX_EXPORT int micfx_lyrics_align (int all)
{
    if (all)
        for (auto& line : words.lines)
            line.pinned = false;
    lyrics::align (words, melody);
    return describeLyrics();
}

/** Moves a line by `seconds` (it stays put from then on). */
MICFX_EXPORT int micfx_lyrics_nudge (int index, double seconds)
{
    if (index >= 0 && index < (int) words.lines.size())
        lyrics::nudge (words, index, seconds, melody);
    return describeLyrics();
}

//==============================================================================
/** Practice's sections: the song's map (analysis/Structure) as [{ name, kind, letter, colour, start, end, bars }]. */
MICFX_EXPORT int micfx_song_sections (const float* samples, int frames, double sampleRate)
{
    juce::AudioBuffer<float> mono (1, juce::jmax (1, frames));
    mono.clear();
    if (frames > 0)
        mono.copyFrom (0, 0, samples, frames);
    const auto map = analysis::structure::analyse (mono, sampleRate);
    juce::StringArray list;
    for (const auto& s : map.sections)
        list.add ("{\"name\":" + quoted (s.name) + ",\"kind\":" + quoted (s.kind) + ",\"letter\":" + quoted (s.getLetterName())
                  + ",\"colour\":" + quoted (s.getColour()) + ",\"start\":" + fixed (s.start, 3) + ",\"end\":" + fixed (s.end, 3)
                  + ",\"bars\":" + juce::String (s.bars) + "}");
    return setResult ("[" + list.joinIntoString (",") + "]");
}

//==============================================================================
// Practice's key and speed: the song's audio warped and transposed by the DAW's Warp
// (daw/Warp), as the desktop's Practice renders it. Planar channels in; the copy is kept
// here until micfx_warp_free, read at micfx_warp_output.
namespace
{
    juce::AudioBuffer<float> warped;
}

MICFX_EXPORT int micfx_warp_render (const float* planar, int channels, int frames, double rate, double speed, double semitones, int voice)
{
    juce::AudioBuffer<float> source (juce::jmax (1, channels), juce::jmax (1, frames));
    source.clear();
    for (int ch = 0; ch < channels; ++ch)
        source.copyFrom (ch, 0, planar + (size_t) ch * (size_t) frames, frames);

    daw::warp::Settings settings;
    const auto length = frames / rate;
    if (std::abs (speed - 1.0) >= 1.0e-4)
        settings.map = daw::warp::Map (std::vector<daw::warp::Marker> { { 0.0, 0.0 }, { length, length / speed } });
    settings.semitones = semitones;
    settings.algorithm = voice ? daw::warp::Algorithm::solo : daw::warp::Algorithm::mix;
    settings.formant = voice != 0;
    warped = daw::warp::render (source, rate, settings);
    return warped.getNumSamples();
}

MICFX_EXPORT const float* micfx_warp_output (int channel)
{
    return channel >= 0 && channel < warped.getNumChannels() ? warped.getReadPointer (channel) : nullptr;
}

MICFX_EXPORT void micfx_warp_free()
{
    warped.setSize (0, 0);
}
