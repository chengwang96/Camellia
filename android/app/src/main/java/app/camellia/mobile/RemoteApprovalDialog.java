package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.text.InputType;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** One question/permission form for ordinary remote chat and discussions. */
final class RemoteApprovalDialog {
    interface Answer { boolean send(boolean allow, JSONObject input, String optionId) throws Exception; }
    private static final class Field {
        JSONObject question; EditText custom; final List<CompoundButton> choices = new ArrayList<>();
    }
    static AlertDialog show(Activity activity, JSONObject request, String member, Answer answer) {
        boolean zh = activity.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        ChatStyle style = new ChatStyle(activity);
        LinearLayout body = new LinearLayout(activity); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(style.dp(18), style.dp(8), style.dp(18), style.dp(8));
        String nativeDetails = request.optString("details"), reason = request.optString("reason");
        String description = String.join("\n", reason, nativeDetails.equals("{}") ? "" : nativeDetails).trim();
        if (!description.isEmpty()) {
            TextView details = new TextView(activity); details.setText(description);
            details.setTextSize(13); details.setTextColor(style.muted); details.setTypeface(Typeface.MONOSPACE); details.setTextIsSelectable(true); body.addView(details);
        }
        List<Field> fields = new ArrayList<>(); JSONArray questions = request.optJSONArray("questions");
        for (int index = 0; questions != null && index < questions.length(); index++) {
            JSONObject question = questions.optJSONObject(index); if (question == null) continue;
            Field field = new Field(); field.question = question; fields.add(field);
            TextView label = new TextView(activity); label.setText(question.optString("question", question.optString("header")));
            label.setTextSize(16); label.setTextColor(style.ink); label.setPadding(0, style.dp(18), 0, style.dp(8)); body.addView(label);
            boolean multi = question.optBoolean("multiSelect");
            LinearLayout choices = multi ? new LinearLayout(activity) : new RadioGroup(activity); choices.setOrientation(LinearLayout.VERTICAL); body.addView(choices);
            JSONArray options = question.optJSONArray("options");
            for (int optionIndex = 0; options != null && optionIndex < options.length(); optionIndex++) {
                JSONObject option = options.optJSONObject(optionIndex); if (option == null) continue;
                CompoundButton choice = multi ? new CheckBox(activity) : new RadioButton(activity);
                String value = option.optString("label"); choice.setText(option.optString("description").isEmpty() ? value : String.join("\n", value, option.optString("description")));
                choice.setTextColor(style.ink); choice.setMinHeight(style.dp(48)); choice.setId(android.view.View.generateViewId());
                choice.setTag(value); choices.addView(choice); field.choices.add(choice);
            }
            field.custom = new EditText(activity); field.custom.setTextColor(style.ink); field.custom.setHintTextColor(style.muted);
            field.custom.setHint(zh ? "输入回答（也可补充其他答案）" : "Type an answer or another option"); field.custom.setMinHeight(style.dp(52));
            field.custom.setTag("approvalAnswer:" + question.optString("id")); field.custom.setMaxLines(4);
            field.custom.setInputType(InputType.TYPE_CLASS_TEXT | (question.optBoolean("isSecret") ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_MULTI_LINE));
            field.custom.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO); body.addView(field.custom);
        }
        TextView error = new TextView(activity); error.setTextColor(new SettingsStyle(activity).error); body.addView(error);
        ScrollView scroll = new ScrollView(activity); scroll.addView(body);
        AlertDialog dialog = new CamelliaDialog.Builder(activity).setTitle((member.isEmpty() ? "" : member + " · ") + request.optString("toolName"))
            .setView(scroll).setNeutralButton(zh ? "稍后" : "Later", null)
            .setNegativeButton(fields.isEmpty() ? (zh ? "拒绝" : "Deny") : (zh ? "跳过问题" : "Skip questions"), null)
            .setPositiveButton(fields.isEmpty() ? (zh ? "允许一次" : "Allow once") : (zh ? "提交回答" : "Submit answers"), null).create();
        dialog.show();
        for (boolean allow : new boolean[]{false, true}) dialog.getButton(allow ? AlertDialog.BUTTON_POSITIVE : AlertDialog.BUTTON_NEGATIVE).setOnClickListener(view -> {
                try {
                    JSONObject input = null;
                    if (allow && !fields.isEmpty()) {
                        input = new JSONObject();
                        for (Field field : fields) {
                            JSONArray values = new JSONArray();
                            for (CompoundButton choice : field.choices) if (choice.isChecked()) values.put(choice.getTag().toString());
                            String custom = field.custom.getText().toString().trim(); if (!custom.isEmpty()) values.put(custom);
                            if (values.length() == 0) throw new IllegalArgumentException(zh ? "请回答每个问题。" : "Answer each question.");
                            input.put(field.question.getString("id"), field.question.optBoolean("multiSelect") ? values : values.getString(values.length() - 1));
                        }
                    }
                    String optionId = null; JSONArray options = request.optJSONArray("options");
                    for (int i = 0; options != null && i < options.length(); i++) {
                        JSONObject option = options.getJSONObject(i);
                        if (option.optString("kind").equals(allow ? "allow_once" : "reject_once")) { optionId = option.getString("optionId"); break; }
                    }
                    if (answer.send(allow, input, optionId)) dialog.dismiss();
                } catch (Exception failure) { error.setText(failure.getMessage()); }
        });
        return dialog;
    }
}
