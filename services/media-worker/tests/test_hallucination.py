from ao_worker.hallucination import flag_segments, load_known_phrases, normalize

SPEECH = [(0.0, 10.0)]


def seg(start=0.0, end=2.0, text="hello there", avg=-0.2, nsp=0.05, cr=1.2, **kw):
    return {"start": start, "end": end, "text": text, "avgLogprob": avg, "noSpeechProb": nsp, "compressionRatio": cr, **kw}


def flags(segments, regions=SPEECH):
    return [s["flags"] for s in flag_segments(segments, regions)]


def test_clean_segment_has_no_flags():
    assert flags([seg()]) == [[]]


def test_low_confidence():
    assert flags([seg(avg=-1.2)]) == [["low-confidence"]]
    assert flags([seg(avg=-1.0)]) == [[]]


def test_no_speech_needs_text():
    assert flags([seg(nsp=0.7)]) == [["no-speech"]]
    assert flags([seg(nsp=0.7, text="  ")]) == [[]]
    assert flags([seg(nsp=0.6)]) == [[]]


def test_repetition_by_compression_ratio():
    assert flags([seg(cr=2.5)]) == [["repetition"]]
    assert flags([seg(cr=2.4)]) == [[]]


def test_repetition_by_three_consecutive_identical_segments():
    segs = [seg(0, 1, "We go."), seg(1, 2, "we go"), seg(2, 3, "WE GO!"), seg(3, 4, "something else")]
    assert flags(segs) == [["repetition"], ["repetition"], ["repetition"], []]
    # two in a row is not a loop; three non-consecutive are not either
    segs = [seg(0, 1, "we go"), seg(1, 2, "we go"), seg(2, 3, "other"), seg(3, 4, "we go")]
    assert flags(segs) == [[], [], [], []]


def test_outside_speech():
    regions = [(0.0, 1.0)]
    assert flags([seg(0.0, 10.0)], regions) == [["outside-speech"]]  # 10% overlap
    assert flags([seg(0.0, 4.0)], regions) == [[]]  # 25% overlap
    assert flags([seg(5.0, 6.0)], []) == [["outside-speech"]]


def test_known_phrase_over_silence_is_flagged():
    over_silence = seg(20.0, 22.0, "Thanks for watching!", nsp=0.2)
    out = flags([over_silence], [(0.0, 10.0)])
    assert out == [["outside-speech", "known-phrase"]]


def test_known_phrase_with_no_speech_prob_is_flagged():
    assert flags([seg(text="Please subscribe.", nsp=0.8)]) == [["no-speech", "known-phrase"]]


def test_known_phrase_inside_speech_is_not_flagged():
    assert flags([seg(0.0, 2.0, "Thanks for watching!")], [(0.0, 10.0)]) == [[]]


def test_known_phrases_file_and_normalize():
    phrases = load_known_phrases()
    assert "thanks for watching" in phrases
    assert "please subscribe" in phrases
    assert any(p.startswith("subtitles by") for p in phrases)
    assert normalize("  Thanks,  for WATCHING!! ") == "thanks for watching"


def test_flag_order_is_stable_and_input_not_mutated():
    s = seg(20.0, 22.0, "thanks for watching", avg=-1.5, nsp=0.9, cr=3.0)
    out = flag_segments([s], [(0.0, 1.0)])
    assert out[0]["flags"] == ["low-confidence", "no-speech", "repetition", "outside-speech", "known-phrase"]
    assert "flags" not in s
