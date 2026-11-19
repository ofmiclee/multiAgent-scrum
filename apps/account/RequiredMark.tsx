/** Visual marker only; the control retains its own required/aria-required semantics. */
export default function RequiredMark({required=true}:{required?:boolean}){
  return required?<span className="required-mark" aria-hidden="true"/>:null;
}
