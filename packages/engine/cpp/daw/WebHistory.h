#pragma once

// What the web DAW keeps in the browser on top of the desktop's project files, so closing the
// tab never loses work (plan points 21 and 23):
//
// - Autosave: a second after the last change (at most five seconds apart while the person
//   keeps working), the session goes to the project's Backups/ (the desktop's own autosave
//   files). The tab never closes cleanly, so on the next visit the newest autosave is picked
//   up without asking.
// - Versions: every few minutes of work, and on each Save, a copy goes to Versions/. The page
//   lists them and goes back to one as an undoable step.
// - Undo history that survives a reload: after each step the session is snapshotted, and the
//   snapshots go to History/. When the project opens again and is where the history left it,
//   the undo (and redo) steps are rebuilt from the snapshots.
//
//   My Song.micfx/
//     History/history.json  { base, position, steps: [{ name, file }] }
//     History/state-<n>.bin the session after each step (ValueTree binary, types kept)
//     Versions/version-<ms>-<saved|auto>.xml
//
// Message thread only.
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_data_structures/juce_data_structures.h>

#include "daw/Edit.h"
#include "daw/Project.h"

class WebHistory : private juce::ChangeListener,
                   private juce::ValueTree::Listener
{
public:
    static constexpr int maxSteps = 50;
    static constexpr int maxVersions = 20;
    static constexpr int versionEveryMs = 3 * 60 * 1000;

    // `emit` sends an event to the page ("webSaved" { time }).
    WebHistory (daw::Edit&, daw::Project&, std::function<void (const juce::String&, const juce::var&)> emit);
    ~WebHistory() override;

    // Called once the bridge has reopened the last project (or made a new one): picks up the
    // newest autosave and the saved undo history.
    void start();

    // From the 30 Hz tick: autosave, versions, following the open project.
    void tick();

    // Writes whatever is waiting (autosave, history) now.
    void flush();

    // { savedAt, path, versions: [{ id, time, saved }] }
    juce::var describe() const;
    // Goes back to a version (one undo step). Returns an error, or empty.
    juce::String restoreVersion (const juce::String& id);

    // Session tree helpers (public for the tests).
    static void syncTree (juce::ValueTree target, const juce::ValueTree& source, bool top);
    static juce::String fingerprint (const juce::ValueTree&);

private:
    struct Step { juce::String name; juce::ValueTree state; juce::String file; };

    void changeListenerCallback (juce::ChangeBroadcaster*) override;
    void valueTreePropertyChanged (juce::ValueTree&, const juce::Identifier& property) override { if (property != daw::ids::viewState) touched(); }
    void valueTreeChildAdded (juce::ValueTree&, juce::ValueTree&) override        { touched(); }
    void valueTreeChildRemoved (juce::ValueTree&, juce::ValueTree&, int) override { touched(); }
    void valueTreeChildOrderChanged (juce::ValueTree&, int, int) override         { touched(); }
    void touched();

    bool followProject();
    void followUndo();
    void resetHistory();
    bool loadHistory();
    void writeHistory();
    void autosave();
    void addVersion (const juce::File& from, bool saved);
    juce::Array<juce::File> findVersions() const;
    void applySnapshot (const juce::ValueTree&);

    juce::File historyFolder() const  { return project.getFolder().getChildFile ("History"); }
    juce::File versionsFolder() const { return project.getFolder().getChildFile ("Versions"); }

    daw::Edit& edit;
    daw::Project& project;
    juce::UndoManager& undo;
    std::function<void (const juce::String&, const juce::var&)> emit;

    juce::File folder;            // the project the history belongs to
    std::vector<Step> steps;      // steps[0] is the base (before the first step)
    int position = 0;             // steps[position] is the session now
    int nextFile = 1;
    bool historyDirty = false;
    bool applying = false;        // our own changes to the session

    bool changed = false;         // since the last autosave
    juce::int64 firstChange = 0, lastChange = 0, savedAt = 0, lastVersion = 0;
    bool changedSinceVersion = false;
    bool pendingSave = false, writingBackup = false;
    std::function<void()> previousBeforeWrite;

    friend class SnapshotAction;
    JUCE_DECLARE_NON_COPYABLE (WebHistory)
};
