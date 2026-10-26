import { useDispatch } from "react-redux";
import { setNicknameAction } from "../store/user.action";
import { NickInput } from "../components/NickInput";

export default function Profile() {
  const dispatch = useDispatch();
  const save = () => dispatch(setNicknameAction({ userId: 1, nickname: "a" }));
  return <NickInput onSave={save} />;
}
